//! Stake-backed tenor markets: real stake accounts + CPAMM.
use crate::{
    burn_c, check_cfg, cpamm_out, create_pda, fail, load_acc, mint_signed, store_acc, tok,
    transfer_c, Config, Market, CLAWD_VOTE, MARKET_SPACE, STAKE_CONFIG, TENORS,
};
use solana_program::{
    account_info::{next_account_info, AccountInfo},
    program_pack::Pack,
    borsh1::try_from_slice_unchecked,
    entrypoint::ProgramResult,
    msg,
    program::{invoke, invoke_signed},
    program_error::ProgramError,
    pubkey::Pubkey,
    stake::{
        self,
        instruction as stake_ix,
        state::{Authorized, Lockup as StakeLockup, StakeStateV2},
    },
    system_instruction,
    sysvar::{clock::Clock, rent::Rent, stake_history, Sysvar},
};
use spl_token::state::{Account as TokenAccount, Mint};

fn mkt_seeds(tenor: u8, bump: u8) -> ([u8; 1], [u8; 1]) {
    ([tenor], [bump])
}

fn stake_pda(pid: &Pubkey, tenor: u8, idx: u32) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[b"mstake", &[tenor], &idx.to_le_bytes()], pid)
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum StakePhase {
    ActiveOrActivating,
    Deactivating,
    Inactive,
    Other,
}

fn phase(data: &[u8], epoch: u64) -> StakePhase {
    let Ok(st) = try_from_slice_unchecked::<StakeStateV2>(data) else {
        return StakePhase::Other;
    };
    match st {
        StakeStateV2::Stake(_meta, stake, _) => {
            let d = stake.delegation.deactivation_epoch;
            if d == u64::MAX {
                StakePhase::ActiveOrActivating
            } else if epoch > d {
                StakePhase::Inactive
            } else {
                StakePhase::Deactivating
            }
        }
        StakeStateV2::Initialized(_) | StakeStateV2::Uninitialized => StakePhase::Inactive,
        _ => StakePhase::Other,
    }
}

pub fn init_market(pid: &Pubkey, accounts: &[AccountInfo], tenor_idx: u8, fee_bps: u16) -> ProgramResult {
    let it = &mut accounts.iter();
    let admin = next_account_info(it)?;
    let config = next_account_info(it)?;
    let market = next_account_info(it)?;
    let note_mint = next_account_info(it)?;
    let note_vault = next_account_info(it)?;
    let csol_vault = next_account_info(it)?;
    let csol_mint = next_account_info(it)?;
    let vote = next_account_info(it)?;
    let system = next_account_info(it)?;
    let _token = next_account_info(it)?;
    let c = check_cfg(pid, config)?;
    if !admin.is_signer || *admin.key != c.admin {
        return Err(fail("admin"));
    }
    if (tenor_idx as usize) >= TENORS.len() {
        return Err(fail("tenor"));
    }
    if *csol_mint.key != c.csol_mint {
        return Err(fail("csol"));
    }
    // Prefer Clawd vote; allow override if a valid vote account is passed
    let vote_key = if *vote.key == CLAWD_VOTE || vote.owner == &crate::VOTE_PROGRAM
    {
        *vote.key
    } else {
        return Err(fail("bad vote"));
    };
    let tb = [tenor_idx];
    // New PDA namespace "smarket" so we can re-init alongside legacy markets
    let (maddr, mb) = Pubkey::find_program_address(&[b"smarket", &tb], pid);
    let (nmaddr, nmb) = Pubkey::find_program_address(&[b"snote_mint", &tb], pid);
    let (nvaddr, nvb) = Pubkey::find_program_address(&[b"snote_vault", &tb], pid);
    let (cvaddr, cvb) = Pubkey::find_program_address(&[b"samm_csol", &tb], pid);
    if *market.key != maddr
        || *note_mint.key != nmaddr
        || *note_vault.key != nvaddr
        || *csol_vault.key != cvaddr
    {
        return Err(fail("pda"));
    }
    if market.lamports() != 0 {
        return Err(fail("exists"));
    }
    let epoch = Clock::get()?.epoch;
    let maturity = epoch.saturating_add(TENORS[tenor_idx as usize]);
    create_pda(admin, market, system, MARKET_SPACE, pid, &[b"smarket", &tb, &[mb]])?;
    create_pda(
        admin,
        note_mint,
        system,
        Mint::LEN,
        &spl_token::id(),
        &[b"snote_mint", &tb, &[nmb]],
    )?;
    invoke(
        &spl_token::instruction::initialize_mint2(
            &spl_token::id(),
            note_mint.key,
            market.key,
            None,
            9,
        )?,
        &[note_mint.clone()],
    )?;
    create_pda(
        admin,
        note_vault,
        system,
        TokenAccount::LEN,
        &spl_token::id(),
        &[b"snote_vault", &tb, &[nvb]],
    )?;
    invoke(
        &spl_token::instruction::initialize_account3(
            &spl_token::id(),
            note_vault.key,
            note_mint.key,
            market.key,
        )?,
        &[note_vault.clone(), note_mint.clone()],
    )?;
    create_pda(
        admin,
        csol_vault,
        system,
        TokenAccount::LEN,
        &spl_token::id(),
        &[b"samm_csol", &tb, &[cvb]],
    )?;
    invoke(
        &spl_token::instruction::initialize_account3(
            &spl_token::id(),
            csol_vault.key,
            csol_mint.key,
            market.key,
        )?,
        &[csol_vault.clone(), csol_mint.clone()],
    )?;
    let _ = (nmb, nvb, cvb);
    store_acc(
        &Market {
            tenor_idx,
            bump: mb,
            fee_bps,
            note_mint: *note_mint.key,
            note_vault: *note_vault.key,
            csol_vault: *csol_vault.key,
            reserve_note: 0,
            reserve_csol: 0,
            maturity_epoch: maturity,
            total_locked: 0,
            vote: vote_key,
            n_stakes: 0,
        },
        market,
    )?;
    msg!(
        "smarket tenor={}ep fee={} maturity={} vote={}",
        TENORS[tenor_idx as usize],
        fee_bps,
        maturity,
        vote_key
    );
    Ok(())
}

pub fn lock(pid: &Pubkey, accounts: &[AccountInfo], tenor_idx: u8, lamports: u64) -> ProgramResult {
    // user, config, market, note_mint, user_note, stake_acc, vote,
    // clock, stake_history, stake_config, rent_sysvar, system, stake_program, token
    let it = &mut accounts.iter();
    let user = next_account_info(it)?;
    let config = next_account_info(it)?;
    let market = next_account_info(it)?;
    let note_mint = next_account_info(it)?;
    let user_note = next_account_info(it)?;
    let stake_acc = next_account_info(it)?;
    let vote = next_account_info(it)?;
    let clock_sy = next_account_info(it)?;
    let stake_hist = next_account_info(it)?;
    let stake_cfg = next_account_info(it)?;
    let rent_sy = next_account_info(it)?;
    let system = next_account_info(it)?;
    let stake_prog = next_account_info(it)?;
    let _token = next_account_info(it)?;
    let c = check_cfg(pid, config)?;
    let _ = c;
    if !user.is_signer {
        return Err(fail("sig"));
    }
    if (tenor_idx as usize) >= TENORS.len() || lamports == 0 {
        return Err(fail("tenor/amt"));
    }
    let mut m: Market = load_acc(market)?;
    let (maddr, _) = Pubkey::find_program_address(&[b"smarket", &[tenor_idx]], pid);
    if *market.key != maddr || market.owner != pid || m.tenor_idx != tenor_idx {
        return Err(fail("market"));
    }
    if *note_mint.key != m.note_mint {
        return Err(fail("mint"));
    }
    if *vote.key != m.vote {
        return Err(fail("vote"));
    }
    if *stake_prog.key != stake::program::id() {
        return Err(fail("stake prog"));
    }
    if *stake_hist.key != stake_history::id() || *stake_cfg.key != STAKE_CONFIG {
        return Err(fail("sysvars"));
    }
    let epoch = Clock::get()?.epoch;
    if epoch >= m.maturity_epoch {
        return Err(fail("series matured"));
    }
    let idx = m.n_stakes;
    let (saddr, sb) = stake_pda(pid, tenor_idx, idx);
    if *stake_acc.key != saddr {
        return Err(fail("stake pda"));
    }
    if stake_acc.lamports() != 0 {
        return Err(fail("stake exists"));
    }
    // Clawd Chain requires ~1 SOL minimum stakeable (beyond rent-exempt reserve).
    let rent_min = Rent::get()?.minimum_balance(StakeStateV2::size_of());
    if lamports.saturating_sub(rent_min) < 1_000_000_000 {
        return Err(fail("need >=1 SOL stake + rent"));
    }
    let tb = [tenor_idx];
    let idx_bytes = idx.to_le_bytes();
    let stake_seeds: &[&[u8]] = &[b"mstake", &tb, &idx_bytes, &[sb]];
    // Create stake account (PDA signer)
    invoke_signed(
        &system_instruction::create_account(
            user.key,
            stake_acc.key,
            lamports,
            StakeStateV2::size_of() as u64,
            &stake::program::id(),
        ),
        &[user.clone(), stake_acc.clone(), system.clone()],
        &[stake_seeds],
    )?;
    let authorized = Authorized {
        staker: *market.key,
        withdrawer: *market.key,
    };
    let lockup = StakeLockup {
        unix_timestamp: 0,
        epoch: m.maturity_epoch,
        custodian: *market.key,
    };
    invoke(
        &stake_ix::initialize(stake_acc.key, &authorized, &lockup),
        &[stake_acc.clone(), rent_sy.clone()],
    )?;
    let (tb2, bump) = mkt_seeds(tenor_idx, m.bump);
    let mseeds: &[&[u8]] = &[b"smarket", &tb2, &bump];
    invoke_signed(
        &stake_ix::delegate_stake(stake_acc.key, market.key, vote.key),
        &[
            stake_acc.clone(),
            vote.clone(),
            clock_sy.clone(),
            stake_hist.clone(),
            stake_cfg.clone(),
            market.clone(),
        ],
        &[mseeds],
    )?;
    mint_signed(
        note_mint,
        user_note,
        market,
        lamports,
        mseeds,
    )?;
    m.n_stakes = m.n_stakes.saturating_add(1);
    m.total_locked = m.total_locked.saturating_add(lamports);
    store_acc(&m, market)?;
    msg!(
        "stake-lock {} lamports tenor={}ep stake={} idx={}",
        lamports,
        TENORS[tenor_idx as usize],
        stake_acc.key,
        idx
    );
    Ok(())
}

pub fn deactivate_stakes(pid: &Pubkey, accounts: &[AccountInfo], tenor_idx: u8) -> ProgramResult {
    // Anyone may crank after maturity: market, clock, then remaining = stake accounts
    let it = &mut accounts.iter();
    let market = next_account_info(it)?;
    let clock_sy = next_account_info(it)?;
    let m: Market = load_acc(market)?;
    let (maddr, _) = Pubkey::find_program_address(&[b"smarket", &[tenor_idx]], pid);
    if *market.key != maddr || m.tenor_idx != tenor_idx {
        return Err(fail("market"));
    }
    let epoch = Clock::get()?.epoch;
    if epoch < m.maturity_epoch {
        return Err(fail("not mature"));
    }
    let (tb2, bump) = mkt_seeds(tenor_idx, m.bump);
    let mseeds: &[&[u8]] = &[b"smarket", &tb2, &bump];
    let mut n = 0u32;
    for stake_acc in it {
        let ph = phase(&stake_acc.data.borrow(), epoch);
        if ph == StakePhase::ActiveOrActivating {
            match invoke_signed(
                &stake_ix::deactivate_stake(stake_acc.key, market.key),
                &[stake_acc.clone(), clock_sy.clone(), market.clone()],
                &[mseeds],
            ) {
                Ok(()) => {
                    n += 1;
                    msg!("deactivated {}", stake_acc.key);
                }
                Err(e) => msg!("deactivate skip {}: {:?}", stake_acc.key, e),
            }
        }
    }
    msg!("deactivate_stakes done count~{}", n);
    Ok(())
}

pub fn redeem(pid: &Pubkey, accounts: &[AccountInfo], amount: u64) -> ProgramResult {
    // user, config, market, note_mint, user_note, clock, stake_history, token,
    // then stake accounts to withdraw from (subset or all)
    let it = &mut accounts.iter();
    let user = next_account_info(it)?;
    let config = next_account_info(it)?;
    let market = next_account_info(it)?;
    let note_mint = next_account_info(it)?;
    let user_note = next_account_info(it)?;
    let clock_sy = next_account_info(it)?;
    let stake_hist = next_account_info(it)?;
    let _token = next_account_info(it)?;
    let _c = check_cfg(pid, config)?;
    if !user.is_signer || amount == 0 {
        return Err(fail("sig/amt"));
    }
    let mut m: Market = load_acc(market)?;
    let (maddr, _) = Pubkey::find_program_address(&[b"smarket", &[m.tenor_idx]], pid);
    if *market.key != maddr || market.owner != pid {
        return Err(fail("market"));
    }
    if *note_mint.key != m.note_mint {
        return Err(fail("mint"));
    }
    let epoch = Clock::get()?.epoch;
    if epoch < m.maturity_epoch {
        msg!("not mature epoch={} need={}", epoch, m.maturity_epoch);
        return Err(fail("not mature"));
    }
    let (tb2, bump) = mkt_seeds(m.tenor_idx, m.bump);
    let mseeds: &[&[u8]] = &[b"smarket", &tb2, &bump];
    // Collect remaining accounts as stake accounts
    let stakes: Vec<&AccountInfo> = it.collect();
    // First pass: deactivate any still-active (same tx convenience)
    for s in &stakes {
        if phase(&s.data.borrow(), epoch) == StakePhase::ActiveOrActivating {
            let _ = invoke_signed(
                &stake_ix::deactivate_stake(s.key, market.key),
                &[(*s).clone(), clock_sy.clone(), market.clone()],
                &[mseeds],
            );
        }
    }
    // Second pass: withdraw from inactive
    let mut got: u64 = 0;
    for s in &stakes {
        if got >= amount {
            break;
        }
        if phase(&s.data.borrow(), epoch) != StakePhase::Inactive {
            continue;
        }
        let rent_min = Rent::get()?.minimum_balance(StakeStateV2::size_of());
        let free = s.lamports().saturating_sub(rent_min);
        if free == 0 {
            continue;
        }
        let take = free.min(amount - got);
        // Withdraw `take` to user; leave rent unless taking all
        let withdraw_lamports = if take == free {
            s.lamports() // close account
        } else {
            take
        };
        match invoke_signed(
            &stake_ix::withdraw(
                s.key,
                market.key,
                user.key,
                withdraw_lamports,
                Some(market.key), // custodian — bypass lockup if still in force
            ),
            &[
                (*s).clone(),
                user.clone(),
                clock_sy.clone(),
                stake_hist.clone(),
                market.clone(),
                market.clone(), // custodian signer (same)
            ],
            &[mseeds],
        ) {
            Ok(()) => {
                got = got.saturating_add(if withdraw_lamports > take {
                    take
                } else {
                    withdraw_lamports.min(take)
                });
                // Fix accounting: if we closed, got += take approximately
                if withdraw_lamports > take {
                    got = amount; // closed full remainder
                }
            }
            Err(e) => msg!("withdraw skip {}: {:?}", s.key, e),
        }
    }
    if got < amount {
        msg!("cooldown got={} need={} — retry next epoch", got, amount);
        return Err(fail("cooldown"));
    }
    // If we over-withdrew due to close semantics, still burn `amount` notes only
    burn_c(note_mint, user_note, user, amount)?;
    m.total_locked = m.total_locked.saturating_sub(amount);
    store_acc(&m, market)?;
    msg!("redeem {} from stake at epoch {}", amount, epoch);
    Ok(())
}

pub fn amm_seed(pid: &Pubkey, accounts: &[AccountInfo], note_amount: u64, csol_amount: u64) -> ProgramResult {
    let it = &mut accounts.iter();
    let user = next_account_info(it)?;
    let market = next_account_info(it)?;
    let _note_mint = next_account_info(it)?;
    let user_note = next_account_info(it)?;
    let note_vault = next_account_info(it)?;
    let user_csol = next_account_info(it)?;
    let csol_vault = next_account_info(it)?;
    let _token = next_account_info(it)?;
    if !user.is_signer {
        return Err(fail("sig"));
    }
    if note_amount == 0 || csol_amount == 0 {
        return Err(fail("amt"));
    }
    let mut m: Market = load_acc(market)?;
    let (maddr, _) = Pubkey::find_program_address(&[b"smarket", &[m.tenor_idx]], pid);
    if *market.key != maddr || market.owner != pid {
        return Err(fail("market"));
    }
    if *note_vault.key != m.note_vault || *csol_vault.key != m.csol_vault {
        return Err(fail("vaults"));
    }
    transfer_c(user_note, note_vault, user, note_amount, None)?;
    transfer_c(user_csol, csol_vault, user, csol_amount, None)?;
    m.reserve_note = m.reserve_note.saturating_add(note_amount);
    m.reserve_csol = m.reserve_csol.saturating_add(csol_amount);
    store_acc(&m, market)?;
    let spot = if m.reserve_note > 0 {
        (m.reserve_csol as u128) * 1_000_000_000u128 / (m.reserve_note as u128)
    } else {
        0
    };
    msg!("amm seed rn={} rc={} spot_e9={}", m.reserve_note, m.reserve_csol, spot);
    Ok(())
}

pub fn amm_swap(
    pid: &Pubkey,
    accounts: &[AccountInfo],
    amount_in: u64,
    min_out: u64,
    note_for_csol: bool,
) -> ProgramResult {
    let it = &mut accounts.iter();
    let user = next_account_info(it)?;
    let market = next_account_info(it)?;
    let user_note = next_account_info(it)?;
    let note_vault = next_account_info(it)?;
    let user_csol = next_account_info(it)?;
    let csol_vault = next_account_info(it)?;
    let _token = next_account_info(it)?;
    if !user.is_signer || amount_in == 0 {
        return Err(fail("sig/amt"));
    }
    let mut m: Market = load_acc(market)?;
    let (maddr, _) = Pubkey::find_program_address(&[b"smarket", &[m.tenor_idx]], pid);
    if *market.key != maddr || market.owner != pid {
        return Err(fail("market"));
    }
    if *note_vault.key != m.note_vault || *csol_vault.key != m.csol_vault {
        return Err(fail("vaults"));
    }
    let (tb2, bump) = mkt_seeds(m.tenor_idx, m.bump);
    let seeds: &[&[u8]] = &[b"smarket", &tb2, &bump];
    let out = if note_for_csol {
        let dy = cpamm_out(m.reserve_note, m.reserve_csol, amount_in, m.fee_bps)?;
        if dy < min_out {
            return Err(fail("slippage"));
        }
        transfer_c(user_note, note_vault, user, amount_in, None)?;
        transfer_c(csol_vault, user_csol, market, dy, Some(seeds))?;
        m.reserve_note = m.reserve_note.saturating_add(amount_in);
        m.reserve_csol = m.reserve_csol.saturating_sub(dy);
        dy
    } else {
        let dy = cpamm_out(m.reserve_csol, m.reserve_note, amount_in, m.fee_bps)?;
        if dy < min_out {
            return Err(fail("slippage"));
        }
        transfer_c(user_csol, csol_vault, user, amount_in, None)?;
        transfer_c(note_vault, user_note, market, dy, Some(seeds))?;
        m.reserve_csol = m.reserve_csol.saturating_add(amount_in);
        m.reserve_note = m.reserve_note.saturating_sub(dy);
        dy
    };
    store_acc(&m, market)?;
    msg!("swap in={} out={} note_for_csol={}", amount_in, out, note_for_csol);
    Ok(())
}
