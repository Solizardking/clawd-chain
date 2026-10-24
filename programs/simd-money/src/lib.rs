//! clawd_money — Clawd Chain prototype of toly's "SOL money" SIMD.
//! Stake-weighted oracle, flash cSOL credit + profit tax, collateral CDPs,
//! transferable tenor-note SPL mints, per-tenor CPAMMs, and stake-backed
//! lockups (native stake accounts delegated to the Clawd validator).
#![allow(clippy::too_many_arguments)]

use borsh::{BorshDeserialize, BorshSerialize};
use solana_program::{
    account_info::{next_account_info, AccountInfo},
    entrypoint,
    entrypoint::ProgramResult,
    epoch_stake::get_epoch_stake_for_vote_account,
    instruction::{get_stack_height, TRANSACTION_LEVEL_STACK_HEIGHT},
    msg,
    program::{invoke, invoke_signed},
    program_error::ProgramError,
    program_pack::Pack,
    pubkey::Pubkey,
    rent::Rent,
    system_instruction,
    sysvar::{
        clock::Clock,
        instructions::{self as ixs, load_current_index_checked, load_instruction_at_checked},
        Sysvar,
    },
};
use spl_token::state::{Account as TokenAccount, Mint};

mod stake_mkt;

entrypoint!(process);

pub const MAX_REPORTERS: usize = 8;
pub const TENORS: [u64; 4] = [1, 3, 6, 12];
pub const LIQ_BONUS_BPS: u128 = 500;
pub const VOTE_PROGRAM: Pubkey =
    solana_program::pubkey!("Vote111111111111111111111111111111111111111");
pub const CLAWD_VOTE: Pubkey =
    solana_program::pubkey!("6J5BtS3wGG4jsEwDLoKW9AghcT4fty1PfqNMVcMaQVBA");
pub const STAKE_CONFIG: Pubkey =
    solana_program::pubkey!("StakeConfig11111111111111111111111111111111");

#[derive(BorshSerialize, BorshDeserialize, Debug)]
pub enum Ix {
    Init {
        tax_bps: u16,
        quorum_bps: u16,
        haircut_bps: u16,
        liq_bps: u16,
        max_age_slots: u64,
    },
    RegisterReporter { weight: u64 },
    PostPrice { price: u64 },
    Aggregate,
    FlashMint { amount: u64 },
    Repay,
    DepositMint { collateral: u64, mint_amount: u64 },
    Liquidate { repay_debt: u64 },
    /// Lock SOL into a PDA stake account delegated to Clawd vote; mint notes 1:1.
    Lock { tenor_idx: u8, lamports: u64 },
    /// Burn notes after maturity; withdraw from inactive stake (cooldown-aware).
    Redeem { amount: u64 },
    /// Create stake-backed market (smarket PDAs) + note mint + CPAMM vaults.
    InitMarket { tenor_idx: u8, fee_bps: u16 },
    /// Seed / add AMM liquidity (note + cSOL at chosen ratio → implied yield).
    AmmSeed { note_amount: u64, csol_amount: u64 },
    /// Constant-product swap. `note_for_csol`: true = sell notes for cSOL.
    AmmSwap {
        amount_in: u64,
        min_out: u64,
        note_for_csol: bool,
    },
    /// Permissionless crank: deactivate all market stake accounts after maturity.
    DeactivateStakes { tenor_idx: u8 },
}

#[derive(BorshSerialize, BorshDeserialize, Default, Clone)]
pub struct Config {
    pub admin: Pubkey,
    pub csol_mint: Pubkey,
    pub treasury: Pubkey,
    pub coll_mint: Pubkey,
    pub coll_vault: Pubkey,
    pub stake_vault: Pubkey,
    pub tax_bps: u16,
    pub quorum_bps: u16,
    pub haircut_bps: u16,
    pub liq_bps: u16,
    pub max_age_slots: u64,
    pub bad_debt: u64,
    pub total_tax: u64,
    pub bump: u8,
}

#[derive(BorshSerialize, BorshDeserialize, Default, Clone, Copy)]
pub struct Report {
    pub reporter: Pubkey,
    pub vote: Pubkey,
    pub weight: u64,
    pub price: u64,
    pub slot: u64,
}

#[derive(BorshSerialize, BorshDeserialize, Default, Clone)]
pub struct Oracle {
    pub price: u64,
    pub slot: u64,
    pub weight_reported: u64,
    pub total_weight: u64,
    pub n: u8,
    pub reports: [Report; MAX_REPORTERS],
}

#[derive(BorshSerialize, BorshDeserialize, Default, Clone)]
pub struct Loan {
    pub borrower: Pubkey,
    pub amount: u64,
    pub pre_balance: u64,
    pub active: bool,
}

#[derive(BorshSerialize, BorshDeserialize, Default, Clone)]
pub struct Position {
    pub owner: Pubkey,
    pub collateral: u64,
    pub debt: u64,
}

/// Per-tenor market: fungible note mint + CPAMM + stake-account pool.
#[derive(BorshSerialize, BorshDeserialize, Default, Clone)]
pub struct Market {
    pub tenor_idx: u8,
    pub bump: u8,
    pub fee_bps: u16,
    pub note_mint: Pubkey,
    pub note_vault: Pubkey,
    pub csol_vault: Pubkey,
    pub reserve_note: u64,
    pub reserve_csol: u64,
    pub maturity_epoch: u64,
    pub total_locked: u64,
    pub vote: Pubkey,
    pub n_stakes: u32,
}

const CONFIG_SPACE: usize = 512;
const ORACLE_SPACE: usize = 1024;
const LOAN_SPACE: usize = 128;
const POS_SPACE: usize = 128;
pub const MARKET_SPACE: usize = 512;

pub(crate) fn fail(m: &str) -> ProgramError {
    msg!("err: {}", m);
    ProgramError::Custom(1)
}
pub(crate) fn load_acc<T: BorshDeserialize>(a: &AccountInfo) -> Result<T, ProgramError> {
    let data = a.data.borrow();
    let mut cur: &[u8] = &data;
    T::deserialize(&mut cur).map_err(|_| ProgramError::InvalidAccountData)
}
pub(crate) fn store_acc<T: BorshSerialize>(t: &T, a: &AccountInfo) -> ProgramResult {
    let v = borsh::to_vec(t).map_err(|_| ProgramError::InvalidAccountData)?;
    if v.len() > a.data_len() {
        return Err(fail("account too small"));
    }
    a.data.borrow_mut()[..v.len()].copy_from_slice(&v);
    if v.len() < a.data_len() {
        a.data.borrow_mut()[v.len()..].fill(0);
    }
    Ok(())
}
pub(crate) fn create_pda<'a>(
    payer: &AccountInfo<'a>,
    acct: &AccountInfo<'a>,
    system: &AccountInfo<'a>,
    space: usize,
    owner: &Pubkey,
    sign_seeds: &[&[u8]],
) -> ProgramResult {
    let lamports = Rent::get()?.minimum_balance(space);
    invoke_signed(
        &system_instruction::create_account(payer.key, acct.key, lamports, space as u64, owner),
        &[payer.clone(), acct.clone(), system.clone()],
        &[sign_seeds],
    )
}
pub(crate) fn tok(a: &AccountInfo) -> Result<TokenAccount, ProgramError> {
    if a.owner != &spl_token::id() {
        return Err(fail("not token"));
    }
    TokenAccount::unpack(&a.data.borrow()).map_err(|_| fail("unpack token"))
}
pub(crate) fn check_cfg(pid: &Pubkey, a: &AccountInfo) -> Result<Config, ProgramError> {
    let (addr, _) = Pubkey::find_program_address(&[b"config"], pid);
    if a.owner != pid || *a.key != addr {
        return Err(fail("bad config"));
    }
    load_acc(a)
}
pub(crate) fn mint_signed<'a>(
    mint: &AccountInfo<'a>,
    dest: &AccountInfo<'a>,
    authority: &AccountInfo<'a>,
    amount: u64,
    seeds: &[&[u8]],
) -> ProgramResult {
    let ix = spl_token::instruction::mint_to(
        &spl_token::id(),
        mint.key,
        dest.key,
        authority.key,
        &[],
        amount,
    )?;
    invoke_signed(&ix, &[mint.clone(), dest.clone(), authority.clone()], &[seeds])
}
pub(crate) fn mint_c<'a>(
    c: &Config,
    mint: &AccountInfo<'a>,
    dest: &AccountInfo<'a>,
    config: &AccountInfo<'a>,
    amount: u64,
) -> ProgramResult {
    let bump = [c.bump];
    mint_signed(mint, dest, config, amount, &[b"config", &bump])
}
pub(crate) fn burn_c<'a>(
    mint: &AccountInfo<'a>,
    src: &AccountInfo<'a>,
    authority: &AccountInfo<'a>,
    amount: u64,
) -> ProgramResult {
    let ix = spl_token::instruction::burn(
        &spl_token::id(),
        src.key,
        mint.key,
        authority.key,
        &[],
        amount,
    )?;
    invoke(&ix, &[src.clone(), mint.clone(), authority.clone()])
}
pub(crate) fn transfer_c<'a>(
    src: &AccountInfo<'a>,
    dst: &AccountInfo<'a>,
    authority: &AccountInfo<'a>,
    amount: u64,
    signed: Option<&[&[u8]]>,
) -> ProgramResult {
    let ix = spl_token::instruction::transfer(
        &spl_token::id(),
        src.key,
        dst.key,
        authority.key,
        &[],
        amount,
    )?;
    if let Some(seeds) = signed {
        invoke_signed(&ix, &[src.clone(), dst.clone(), authority.clone()], &[seeds])
    } else {
        invoke(&ix, &[src.clone(), dst.clone(), authority.clone()])
    }
}
fn fresh_price(o: &Oracle, c: &Config) -> Result<u64, ProgramError> {
    let now = Clock::get()?.slot;
    if o.price == 0 || now.saturating_sub(o.slot) > c.max_age_slots {
        return Err(fail("stale oracle"));
    }
    Ok(o.price)
}
fn coll_value(amount: u64, price: u64, haircut_bps: u16) -> u128 {
    let raw = (amount as u128).saturating_mul(price as u128) / 1_000_000_000u128;
    raw.saturating_mul((10_000u128).saturating_sub(haircut_bps as u128)) / 10_000u128
}
fn require_repay_later(pid: &Pubkey, ix_sysvar: &AccountInfo) -> ProgramResult {
    let cur = load_current_index_checked(ix_sysvar)?;
    let mut found = false;
    let mut i = cur as usize + 1;
    loop {
        match load_instruction_at_checked(i, ix_sysvar) {
            Ok(ix) => {
                if ix.program_id == *pid && !ix.data.is_empty() && ix.data[0] == 5 {
                    found = true;
                    break;
                }
                i += 1;
            }
            Err(_) => break,
        }
    }
    if !found {
        return Err(fail("no repay in tx"));
    }
    Ok(())
}
/// CPAMM out given reserves and fee_bps (taken from input).
pub(crate) fn cpamm_out(rx: u64, ry: u64, dx: u64, fee_bps: u16) -> Result<u64, ProgramError> {
    if rx == 0 || ry == 0 || dx == 0 {
        return Err(fail("empty pool"));
    }
    let dx_ef = (dx as u128) * (10_000u128 - fee_bps as u128) / 10_000u128;
    let num = dx_ef.saturating_mul(ry as u128);
    let den = (rx as u128).saturating_add(dx_ef);
    if den == 0 {
        return Err(fail("div0"));
    }
    let dy = num / den;
    if dy == 0 || dy >= ry as u128 {
        return Err(fail("bad out"));
    }
    Ok(dy as u64)
}

pub fn process(pid: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    let ix = Ix::try_from_slice(data).map_err(|_| ProgramError::InvalidInstructionData)?;
    let it = &mut accounts.iter();
    match ix {
        Ix::Init {
            tax_bps,
            quorum_bps,
            haircut_bps,
            liq_bps,
            max_age_slots,
        } => {
            let admin = next_account_info(it)?;
            let config = next_account_info(it)?;
            let oracle = next_account_info(it)?;
            let csol = next_account_info(it)?;
            let treasury = next_account_info(it)?;
            let coll_mint = next_account_info(it)?;
            let coll_vault = next_account_info(it)?;
            let stake_vault = next_account_info(it)?;
            let system = next_account_info(it)?;
            let _token = next_account_info(it)?;
            if !admin.is_signer {
                return Err(fail("admin sig"));
            }
            let (cfg_addr, cb) = Pubkey::find_program_address(&[b"config"], pid);
            let (ora_addr, ob) = Pubkey::find_program_address(&[b"oracle"], pid);
            let (csol_addr, mb) = Pubkey::find_program_address(&[b"csol"], pid);
            let (tr_addr, tb) = Pubkey::find_program_address(&[b"treasury"], pid);
            let (cv_addr, vb) = Pubkey::find_program_address(&[b"cvault"], pid);
            let (sv_addr, sb) = Pubkey::find_program_address(&[b"stakevault"], pid);
            if *config.key != cfg_addr
                || *oracle.key != ora_addr
                || *csol.key != csol_addr
                || *treasury.key != tr_addr
                || *coll_vault.key != cv_addr
                || *stake_vault.key != sv_addr
            {
                return Err(fail("pda mismatch"));
            }
            create_pda(admin, config, system, CONFIG_SPACE, pid, &[b"config", &[cb]])?;
            create_pda(admin, oracle, system, ORACLE_SPACE, pid, &[b"oracle", &[ob]])?;
            create_pda(admin, stake_vault, system, 0, pid, &[b"stakevault", &[sb]])?;
            create_pda(admin, csol, system, Mint::LEN, &spl_token::id(), &[b"csol", &[mb]])?;
            invoke(
                &spl_token::instruction::initialize_mint2(
                    &spl_token::id(),
                    csol.key,
                    config.key,
                    None,
                    9,
                )?,
                &[csol.clone()],
            )?;
            create_pda(
                admin,
                treasury,
                system,
                TokenAccount::LEN,
                &spl_token::id(),
                &[b"treasury", &[tb]],
            )?;
            invoke(
                &spl_token::instruction::initialize_account3(
                    &spl_token::id(),
                    treasury.key,
                    csol.key,
                    config.key,
                )?,
                &[treasury.clone(), csol.clone()],
            )?;
            create_pda(
                admin,
                coll_vault,
                system,
                TokenAccount::LEN,
                &spl_token::id(),
                &[b"cvault", &[vb]],
            )?;
            invoke(
                &spl_token::instruction::initialize_account3(
                    &spl_token::id(),
                    coll_vault.key,
                    coll_mint.key,
                    config.key,
                )?,
                &[coll_vault.clone(), coll_mint.clone()],
            )?;
            let _ = (ob, mb, tb, vb, sb);
            store_acc(
                &Config {
                    admin: *admin.key,
                    csol_mint: *csol.key,
                    treasury: *treasury.key,
                    coll_mint: *coll_mint.key,
                    coll_vault: *coll_vault.key,
                    stake_vault: *stake_vault.key,
                    tax_bps,
                    quorum_bps,
                    haircut_bps,
                    liq_bps,
                    max_age_slots,
                    bad_debt: 0,
                    total_tax: 0,
                    bump: cb,
                },
                config,
            )?;
            store_acc(&Oracle::default(), oracle)?;
            msg!("clawd_money init");
            Ok(())
        }
        Ix::RegisterReporter { weight } => {
            let admin = next_account_info(it)?;
            let config = next_account_info(it)?;
            let oracle = next_account_info(it)?;
            let reporter = next_account_info(it)?;
            let vote = next_account_info(it)?;
            let c = check_cfg(pid, config)?;
            if !admin.is_signer || *admin.key != c.admin {
                return Err(fail("admin"));
            }
            let mut o: Oracle = load_acc(oracle)?;
            if o.n as usize >= MAX_REPORTERS {
                return Err(fail("full"));
            }
            for i in 0..o.n as usize {
                if o.reports[i].reporter == *reporter.key {
                    return Err(fail("dup"));
                }
            }
            let live = if vote.owner == &VOTE_PROGRAM {
                get_epoch_stake_for_vote_account(vote.key)
            } else {
                0
            };
            let w = if live > 0 { live } else { weight };
            if w == 0 {
                return Err(fail("zero weight"));
            }
            let idx = o.n as usize;
            o.reports[idx] = Report {
                reporter: *reporter.key,
                vote: *vote.key,
                weight: w,
                price: 0,
                slot: 0,
            };
            o.n += 1;
            o.total_weight = o.total_weight.saturating_add(w);
            store_acc(&o, oracle)
        }
        Ix::PostPrice { price } => {
            let reporter = next_account_info(it)?;
            let oracle = next_account_info(it)?;
            if !reporter.is_signer || oracle.owner != pid {
                return Err(fail("sig"));
            }
            if price == 0 {
                return Err(fail("zero price"));
            }
            let mut o: Oracle = load_acc(oracle)?;
            let slot = Clock::get()?.slot;
            let mut found = false;
            for i in 0..o.n as usize {
                if o.reports[i].reporter == *reporter.key {
                    o.reports[i].price = price;
                    o.reports[i].slot = slot;
                    found = true;
                    break;
                }
            }
            if !found {
                return Err(fail("unknown reporter"));
            }
            store_acc(&o, oracle)
        }
        Ix::Aggregate => {
            let config = next_account_info(it)?;
            let oracle = next_account_info(it)?;
            let c = check_cfg(pid, config)?;
            let mut o: Oracle = load_acc(oracle)?;
            let now = Clock::get()?.slot;
            let mut fresh: Vec<Report> = Vec::new();
            for i in 0..o.n as usize {
                let r = o.reports[i];
                if r.price > 0 && now.saturating_sub(r.slot) <= c.max_age_slots {
                    fresh.push(r);
                }
            }
            let wsum: u128 = fresh.iter().map(|r| r.weight as u128).sum();
            if o.total_weight == 0
                || wsum * 10_000 < (o.total_weight as u128) * (c.quorum_bps as u128)
            {
                return Err(fail("no quorum"));
            }
            fresh.sort_by_key(|r| r.price);
            let mut acc = 0u128;
            let mut med = fresh[0].price;
            for r in &fresh {
                acc += r.weight as u128;
                if acc * 2 >= wsum {
                    med = r.price;
                    break;
                }
            }
            o.price = med;
            o.slot = now;
            o.weight_reported = wsum as u64;
            store_acc(&o, oracle)
        }
        Ix::FlashMint { amount } => {
            let borrower = next_account_info(it)?;
            let config = next_account_info(it)?;
            let loan = next_account_info(it)?;
            let csol = next_account_info(it)?;
            let bata = next_account_info(it)?;
            let ix_sysvar = next_account_info(it)?;
            let system = next_account_info(it)?;
            let _token = next_account_info(it)?;
            let c = check_cfg(pid, config)?;
            if !borrower.is_signer || amount == 0 {
                return Err(fail("sig/amt"));
            }
            if get_stack_height() != TRANSACTION_LEVEL_STACK_HEIGHT {
                return Err(fail("no CPI flash"));
            }
            if *ix_sysvar.key != ixs::ID || *csol.key != c.csol_mint {
                return Err(fail("accts"));
            }
            require_repay_later(pid, ix_sysvar)?;
            let (loan_addr, lb) =
                Pubkey::find_program_address(&[b"loan", borrower.key.as_ref()], pid);
            if *loan.key != loan_addr {
                return Err(fail("loan pda"));
            }
            if loan.lamports() == 0 {
                create_pda(
                    borrower,
                    loan,
                    system,
                    LOAN_SPACE,
                    pid,
                    &[b"loan", borrower.key.as_ref(), &[lb]],
                )?;
            }
            let mut loan_state: Loan = load_acc(loan).unwrap_or_default();
            if loan_state.active {
                return Err(fail("loan open"));
            }
            let pre = tok(bata)?.amount;
            mint_c(&c, csol, bata, config, amount)?;
            loan_state = Loan {
                borrower: *borrower.key,
                amount,
                pre_balance: pre,
                active: true,
            };
            store_acc(&loan_state, loan)?;
            Ok(())
        }
        Ix::Repay => {
            let borrower = next_account_info(it)?;
            let config = next_account_info(it)?;
            let loan = next_account_info(it)?;
            let csol = next_account_info(it)?;
            let bata = next_account_info(it)?;
            let treasury = next_account_info(it)?;
            let _token = next_account_info(it)?;
            let mut c = check_cfg(pid, config)?;
            if !borrower.is_signer {
                return Err(fail("sig"));
            }
            let (loan_addr, _) =
                Pubkey::find_program_address(&[b"loan", borrower.key.as_ref()], pid);
            if *loan.key != loan_addr || loan.owner != pid {
                return Err(fail("loan"));
            }
            let mut loan_state: Loan = load_acc(loan)?;
            if !loan_state.active || loan_state.borrower != *borrower.key {
                return Err(fail("no active loan"));
            }
            if *csol.key != c.csol_mint || *treasury.key != c.treasury {
                return Err(fail("mint/treas"));
            }
            let bal = tok(bata)?.amount;
            let amount = loan_state.amount;
            let pre = loan_state.pre_balance;
            let after_credit = pre.saturating_add(amount);
            let profit = bal.saturating_sub(after_credit);
            let tax = ((profit as u128) * (c.tax_bps as u128) / 10_000u128) as u64;
            if bal < after_credit.saturating_add(tax) {
                return Err(fail("underpaid"));
            }
            burn_c(csol, bata, borrower, amount)?;
            if tax > 0 {
                transfer_c(bata, treasury, borrower, tax, None)?;
            }
            c.total_tax = c.total_tax.saturating_add(tax);
            store_acc(&c, config)?;
            loan_state.active = false;
            loan_state.amount = 0;
            store_acc(&loan_state, loan)?;
            msg!("repay tax={}", tax);
            Ok(())
        }
        Ix::DepositMint {
            collateral,
            mint_amount,
        } => {
            let user = next_account_info(it)?;
            let config = next_account_info(it)?;
            let oracle = next_account_info(it)?;
            let pos = next_account_info(it)?;
            let csol = next_account_info(it)?;
            let uata = next_account_info(it)?;
            let ucoll = next_account_info(it)?;
            let vault = next_account_info(it)?;
            let system = next_account_info(it)?;
            let _token = next_account_info(it)?;
            let c = check_cfg(pid, config)?;
            if !user.is_signer {
                return Err(fail("sig"));
            }
            let o: Oracle = load_acc(oracle)?;
            let price = fresh_price(&o, &c)?;
            if (mint_amount as u128) > coll_value(collateral, price, c.haircut_bps) {
                return Err(fail("over-mint"));
            }
            let (paddr, pb) = Pubkey::find_program_address(&[b"pos", user.key.as_ref()], pid);
            if *pos.key != paddr {
                return Err(fail("pos pda"));
            }
            if pos.lamports() == 0 {
                create_pda(
                    user,
                    pos,
                    system,
                    POS_SPACE,
                    pid,
                    &[b"pos", user.key.as_ref(), &[pb]],
                )?;
            }
            let mut p: Position = load_acc(pos).unwrap_or_default();
            if p.owner != Pubkey::default() && p.owner != *user.key {
                return Err(fail("pos owner"));
            }
            if *vault.key != c.coll_vault || *csol.key != c.csol_mint {
                return Err(fail("vault/mint"));
            }
            transfer_c(ucoll, vault, user, collateral, None)?;
            mint_c(&c, csol, uata, config, mint_amount)?;
            p.owner = *user.key;
            p.collateral = p.collateral.saturating_add(collateral);
            p.debt = p.debt.saturating_add(mint_amount);
            store_acc(&p, pos)?;
            Ok(())
        }
        Ix::Liquidate { repay_debt } => {
            let liq = next_account_info(it)?;
            let config = next_account_info(it)?;
            let oracle = next_account_info(it)?;
            let pos = next_account_info(it)?;
            let csol = next_account_info(it)?;
            let lata = next_account_info(it)?;
            let lcoll = next_account_info(it)?;
            let vault = next_account_info(it)?;
            let _token = next_account_info(it)?;
            let mut c = check_cfg(pid, config)?;
            if !liq.is_signer {
                return Err(fail("sig"));
            }
            let o: Oracle = load_acc(oracle)?;
            let price = fresh_price(&o, &c)?;
            let mut p: Position = load_acc(pos)?;
            if p.debt == 0 {
                return Err(fail("no debt"));
            }
            let value = coll_value(p.collateral, price, 0);
            let threshold = (p.debt as u128) * (c.liq_bps as u128) / 10_000u128;
            if value >= threshold {
                return Err(fail("healthy"));
            }
            let repay = repay_debt.min(p.debt);
            let seized_raw = (repay as u128).saturating_mul(1_000_000_000u128)
                / (price as u128).max(1);
            let seized = (seized_raw * (10_000 + LIQ_BONUS_BPS) / 10_000)
                .min(p.collateral as u128) as u64;
            burn_c(csol, lata, liq, repay)?;
            let bump = [c.bump];
            transfer_c(vault, lcoll, config, seized, Some(&[b"config", &bump]))?;
            p.debt = p.debt.saturating_sub(repay);
            p.collateral = p.collateral.saturating_sub(seized);
            if p.collateral == 0 && p.debt > 0 {
                c.bad_debt = c.bad_debt.saturating_add(p.debt);
                p.debt = 0;
            }
            store_acc(&p, pos)?;
            store_acc(&c, config)?;
            Ok(())
        }
        Ix::Lock { tenor_idx, lamports } => stake_mkt::lock(pid, accounts, tenor_idx, lamports),
        Ix::Redeem { amount } => stake_mkt::redeem(pid, accounts, amount),
        Ix::InitMarket { tenor_idx, fee_bps } => stake_mkt::init_market(pid, accounts, tenor_idx, fee_bps),
        Ix::AmmSeed { note_amount, csol_amount } => {
            stake_mkt::amm_seed(pid, accounts, note_amount, csol_amount)
        }
        Ix::AmmSwap { amount_in, min_out, note_for_csol } => {
            stake_mkt::amm_swap(pid, accounts, amount_in, min_out, note_for_csol)
        }
        Ix::DeactivateStakes { tenor_idx } => stake_mkt::deactivate_stakes(pid, accounts, tenor_idx),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn coll_value_haircut() {
        assert_eq!(coll_value(1_000_000_000, 1_000_000_000, 1000), 900_000_000);
    }
    #[test]
    fn cpamm_basic() {
        // 100/100 pool, swap 10 in, 0 fee → out = 100 - 10000/110 ≈ 9
        let o = cpamm_out(100, 100, 10, 0).unwrap();
        assert_eq!(o, 9);
    }
}
