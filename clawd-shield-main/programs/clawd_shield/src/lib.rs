//! clawd_shield — shielded CLAWD pool (testnet, unaudited).
//! Groth16 (BN254) proofs over a Poseidon incremental Merkle tree, nullifier PDAs,
//! on-chain computed publicAmount + extDataHash, deposit caps, relayer fee.
use anchor_lang::prelude::*;
use anchor_lang::solana_program::{program::invoke_signed, system_instruction};
use solana_sha256_hasher::hashv as sha256v;
use groth16_solana::groth16::Groth16Verifier;
use solana_poseidon::{hashv as poseidonv, Endianness, Parameters};

mod vk;
use vk::*;

declare_id!("2AMyS5oLqvh2j4We5EUe9cHryd2vrCuVSdZtsZrP2PVH");

pub const LEVELS: usize = 20;
pub const ROOT_HISTORY: usize = 100;
pub const ASSET_ID_CLAWD: u64 = 1;
pub const MAX_DEPOSIT: u64 = 100 * 1_000_000_000; // 100 CLAWD per deposit
pub const MAX_TVL: u64 = 10_000 * 1_000_000_000; // 10k CLAWD total
pub const MAX_ENC_LEN: usize = 160;
/// BN254 scalar field modulus r (big-endian)
pub const FR: [u8; 32] = [
    0x30, 0x64, 0x4e, 0x72, 0xe1, 0x31, 0xa0, 0x29, 0xb8, 0x50, 0x45, 0xb6, 0x81, 0x81, 0x58, 0x5d,
    0x28, 0x33, 0xe8, 0x48, 0x79, 0xb9, 0x70, 0x91, 0x43, 0xe1, 0xf5, 0x93, 0xf0, 0x00, 0x00, 0x01,
];
/// BN254 base field modulus q (big-endian) — used to negate proof A.
pub const FQ: [u8; 32] = [
    0x30, 0x64, 0x4e, 0x72, 0xe1, 0x31, 0xa0, 0x29, 0xb8, 0x50, 0x45, 0xb6, 0x81, 0x81, 0x58, 0x5d,
    0x97, 0x81, 0x6a, 0x91, 0x68, 0x71, 0xca, 0x8d, 0x3c, 0x20, 0x8c, 0x16, 0xd8, 0x7c, 0xfd, 0x47,
];

#[program]
pub mod clawd_shield {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        let mut pool = ctx.accounts.pool.load_init()?;
        pool.authority = ctx.accounts.authority.key();
        pool.asset_id = ASSET_ID_CLAWD;
        pool.max_deposit = MAX_DEPOSIT;
        pool.max_tvl = MAX_TVL;
        pool.vault_bump = ctx.bumps.vault;
        let mut z = [0u8; 32];
        for i in 0..LEVELS {
            pool.zeros[i] = z;
            pool.filled_subtrees[i] = z;
            z = poseidon2(&z, &z)?;
        }
        pool.roots[0] = z;
        pool.root_index = 0;
        pool.next_index = 0;
        Ok(())
    }

    pub fn set_paused(ctx: Context<Admin>, paused: bool) -> Result<()> {
        let mut pool = ctx.accounts.pool.load_mut()?;
        require_keys_eq!(pool.authority, ctx.accounts.authority.key(), ShieldError::Unauthorized);
        pool.paused = paused as u8;
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    pub fn transact(
        ctx: Context<Transact>,
        proof: ProofBytes,
        root: [u8; 32],
        nf0: [u8; 32],
        nf1: [u8; 32],
        out0: [u8; 32],
        out1: [u8; 32],
        ext_amount: i64,
        fee: u64,
        enc_out1: Vec<u8>,
        enc_out2: Vec<u8>,
    ) -> Result<()> {
        let input_nullifiers = [nf0, nf1];
        let output_commitments = [out0, out1];
        require!(enc_out1.len() <= MAX_ENC_LEN && enc_out2.len() <= MAX_ENC_LEN, ShieldError::EncTooLong);
        let mut pool = ctx.accounts.pool.load_mut()?;
        require!(pool.paused == 0, ShieldError::Paused);
        require!(root != [0u8; 32] && pool.is_known_root(&root), ShieldError::UnknownRoot);
        for c in output_commitments.iter().chain(input_nullifiers.iter()) {
            require!(lt_be(c, &FR), ShieldError::NotInField);
        }
        require!(ext_amount > i64::MIN, ShieldError::BadAmount);
        require!(fee <= MAX_TVL, ShieldError::BadAmount);
        if ext_amount > 0 {
            require!(fee == 0, ShieldError::BadAmount);
            require!((ext_amount as u64) <= pool.max_deposit, ShieldError::DepositCap);
        }

        // ---- extDataHash binds recipient, relayer, amounts, fee and encrypted notes
        let ext_hash = ext_data_hash(
            &ctx.accounts.recipient.key(), &ctx.accounts.relayer.key(), ext_amount, fee, &enc_out1, &enc_out2,
        );
        // ---- publicAmount = extAmount - fee  (mod r)
        let public_amount = field_from_i128(ext_amount as i128 - fee as i128);
        let mut asset = [0u8; 32];
        asset[24..].copy_from_slice(&pool.asset_id.to_be_bytes());

        let public_inputs: [[u8; 32]; NR_PUBLIC_INPUTS] = [
            root, public_amount, ext_hash,
            input_nullifiers[0], input_nullifiers[1],
            output_commitments[0], output_commitments[1],
            asset,
        ];
        verify_proof(&proof, &public_inputs)?;

        // ---- move funds
        let vault_bump = pool.vault_bump;
        let seeds: &[&[u8]] = &[b"vault", &[vault_bump]];
        if ext_amount > 0 {
            let amt = ext_amount as u64;
            let tvl = ctx.accounts.vault.lamports().checked_add(amt).ok_or(ShieldError::BadAmount)?;
            require!(tvl <= pool.max_tvl, ShieldError::TvlCap);
            anchor_lang::system_program::transfer(
                CpiContext::new(ctx.accounts.system_program.to_account_info(),
                    anchor_lang::system_program::Transfer { from: ctx.accounts.signer.to_account_info(), to: ctx.accounts.vault.to_account_info() }),
                amt,
            )?;
            pool.total_deposited = pool.total_deposited.saturating_add(amt);
        } else if ext_amount < 0 {
            let amt = ext_amount.unsigned_abs();
            invoke_signed(&system_instruction::transfer(&ctx.accounts.vault.key(), &ctx.accounts.recipient.key(), amt),
                &[ctx.accounts.vault.to_account_info(), ctx.accounts.recipient.to_account_info(), ctx.accounts.system_program.to_account_info()],
                &[seeds])?;
            pool.total_withdrawn = pool.total_withdrawn.saturating_add(amt);
        }
        if fee > 0 {
            invoke_signed(&system_instruction::transfer(&ctx.accounts.vault.key(), &ctx.accounts.relayer.key(), fee),
                &[ctx.accounts.vault.to_account_info(), ctx.accounts.relayer.to_account_info(), ctx.accounts.system_program.to_account_info()],
                &[seeds])?;
        }

        // ---- insert outputs
        let idx0 = pool.next_index;
        pool.insert(&output_commitments[0])?;
        pool.insert(&output_commitments[1])?;
        let new_root = pool.roots[pool.root_index as usize];
        drop(pool);
        ctx.accounts.nullifier0.nullifier = input_nullifiers[0];
        ctx.accounts.nullifier1.nullifier = input_nullifiers[1];

        emit!(NewCommitment { index: idx0, commitment: output_commitments[0], encrypted_output: enc_out1 });
        emit!(NewCommitment { index: idx0 + 1, commitment: output_commitments[1], encrypted_output: enc_out2 });
        emit!(NewNullifiers { nullifiers: input_nullifiers, root: new_root, ext_amount, fee });
        Ok(())
    }
}

// ------------------------------------------------------------------ helpers
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct ProofBytes {
    /// A in uncompressed big-endian (x||y). The program negates it.
    pub a: [u8; 64],
    /// B as x.c1||x.c0||y.c1||y.c0 big-endian
    pub b: [u8; 128],
    pub c: [u8; 64],
}

pub fn poseidon2(a: &[u8; 32], b: &[u8; 32]) -> Result<[u8; 32]> {
    let h = poseidonv(Parameters::Bn254X5, Endianness::BigEndian, &[a, b]).map_err(|_| ShieldError::Poseidon)?;
    Ok(h.to_bytes())
}

fn lt_be(a: &[u8; 32], m: &[u8; 32]) -> bool { a < m }

fn sub_be(m: &[u8; 32], a: &[u8; 32]) -> [u8; 32] {
    // m - a, assuming a <= m
    let mut out = [0u8; 32];
    let mut borrow = 0i16;
    for i in (0..32).rev() {
        let mut d = m[i] as i16 - a[i] as i16 - borrow;
        if d < 0 { d += 256; borrow = 1 } else { borrow = 0 }
        out[i] = d as u8;
    }
    out
}

pub fn field_from_i128(v: i128) -> [u8; 32] {
    let mut mag = [0u8; 32];
    mag[16..].copy_from_slice(&v.unsigned_abs().to_be_bytes());
    if v >= 0 { mag } else { sub_be(&FR, &mag) }
}

pub fn ext_data_hash(recipient: &Pubkey, relayer: &Pubkey, ext_amount: i64, fee: u64, e1: &[u8], e2: &[u8]) -> [u8; 32] {
    let h = sha256v(&[
        recipient.as_ref(), relayer.as_ref(), &ext_amount.to_le_bytes(), &fee.to_le_bytes(),
        &(e1.len() as u32).to_le_bytes(), e1, &(e2.len() as u32).to_le_bytes(), e2,
    ]).to_bytes();
    let mut out = h;
    out[0] = 0; // < 2^248 < r
    out
}

fn verify_proof(proof: &ProofBytes, inputs: &[[u8; 32]; NR_PUBLIC_INPUTS]) -> Result<()> {
    // negate A: (x, q - y)
    let mut a = [0u8; 64];
    a[..32].copy_from_slice(&proof.a[..32]);
    let y: [u8; 32] = proof.a[32..].try_into().unwrap();
    require!(lt_be(&y, &FQ), ShieldError::InvalidProof);
    let ny = if y == [0u8; 32] { y } else { sub_be(&FQ, &y) };
    a[32..].copy_from_slice(&ny);
    let mut v = Box::new(
        Groth16Verifier::new(&a, &proof.b, &proof.c, inputs, &VERIFYING_KEY).map_err(|_| ShieldError::InvalidProof)?,
    );
    v.verify().map_err(|_| ShieldError::InvalidProof)?;
    Ok(())
}

// ------------------------------------------------------------------ state
#[account(zero_copy)]
pub struct Pool {
    pub authority: Pubkey,
    pub asset_id: u64,
    pub max_deposit: u64,
    pub max_tvl: u64,
    pub total_deposited: u64,
    pub total_withdrawn: u64,
    pub next_index: u32,
    pub root_index: u32,
    pub vault_bump: u8,
    pub paused: u8,
    pub _pad: [u8; 6],
    pub zeros: [[u8; 32]; LEVELS],
    pub filled_subtrees: [[u8; 32]; LEVELS],
    pub roots: [[u8; 32]; ROOT_HISTORY],
}

impl Pool {
    pub fn is_known_root(&self, r: &[u8; 32]) -> bool { self.roots.iter().any(|x| x == r) }
    pub fn insert(&mut self, leaf: &[u8; 32]) -> Result<()> {
        let mut idx = self.next_index;
        require!((idx as u64) < (1u64 << LEVELS), ShieldError::TreeFull);
        let mut cur = *leaf;
        for i in 0..LEVELS {
            if idx & 1 == 0 {
                self.filled_subtrees[i] = cur;
                cur = poseidon2(&cur, &self.zeros[i])?;
            } else {
                cur = poseidon2(&self.filled_subtrees[i], &cur)?;
            }
            idx >>= 1;
        }
        self.root_index = (self.root_index + 1) % ROOT_HISTORY as u32;
        self.roots[self.root_index as usize] = cur;
        self.next_index += 1;
        Ok(())
    }
}

#[account]
pub struct Nullifier { pub nullifier: [u8; 32] }

// ------------------------------------------------------------------ accounts
#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(init, payer = authority, space = 8 + std::mem::size_of::<Pool>(), seeds = [b"pool"], bump)]
    pub pool: AccountLoader<'info, Pool>,
    /// CHECK: lamport vault PDA (system-owned, no data)
    #[account(mut, seeds = [b"vault"], bump)]
    pub vault: SystemAccount<'info>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Admin<'info> {
    #[account(mut, seeds = [b"pool"], bump)]
    pub pool: AccountLoader<'info, Pool>,
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
#[instruction(proof: ProofBytes, root: [u8; 32], nf0: [u8; 32], nf1: [u8; 32])]
pub struct Transact<'info> {
    #[account(mut, seeds = [b"pool"], bump)]
    pub pool: AccountLoader<'info, Pool>,
    #[account(mut, seeds = [b"vault"], bump)]
    pub vault: SystemAccount<'info>,
    #[account(init, payer = signer, space = 8 + 32, seeds = [b"nf", nf0.as_ref()], bump)]
    pub nullifier0: Account<'info, Nullifier>,
    #[account(init, payer = signer, space = 8 + 32, seeds = [b"nf", nf1.as_ref()], bump)]
    pub nullifier1: Account<'info, Nullifier>,
    /// CHECK: bound into extDataHash; receives withdrawals
    #[account(mut)]
    pub recipient: UncheckedAccount<'info>,
    /// CHECK: bound into extDataHash; receives fee
    #[account(mut)]
    pub relayer: UncheckedAccount<'info>,
    #[account(mut)]
    pub signer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

// ------------------------------------------------------------------ events / errors
#[event]
pub struct NewCommitment { pub index: u32, pub commitment: [u8; 32], pub encrypted_output: Vec<u8> }
#[event]
pub struct NewNullifiers { pub nullifiers: [[u8; 32]; 2], pub root: [u8; 32], pub ext_amount: i64, pub fee: u64 }

#[error_code]
pub enum ShieldError {
    #[msg("invalid proof")] InvalidProof,
    #[msg("unknown merkle root")] UnknownRoot,
    #[msg("value not in field")] NotInField,
    #[msg("bad amount")] BadAmount,
    #[msg("deposit above 100 CLAWD cap")] DepositCap,
    #[msg("pool TVL cap (10k CLAWD) reached")] TvlCap,
    #[msg("tree full")] TreeFull,
    #[msg("poseidon syscall failed")] Poseidon,
    #[msg("encrypted output too long")] EncTooLong,
    #[msg("paused")] Paused,
    #[msg("unauthorized")] Unauthorized,
}
