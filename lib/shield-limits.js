// Deposit and TVL caps for the clawd_shield program.
// Amounts are lamports as decimal strings. 1 CLAWD = 1_000_000_000 lamports.
// This module does not read a vault account and does not call a validator.

const PROGRAM_ID = '2AMyS5oLqvh2j4We5EUe9cHryd2vrCuVSdZtsZrP2PVH';
const LAMPORTS = 1_000_000_000n;
const MAX_DEPOSIT = 100n * LAMPORTS;
const MAX_TVL = 10_000n * LAMPORTS;
const LEVELS = 20;
const ASSET_ID = '1';
const ROOT_HISTORY = 100;
const MAX_ENC_LEN = 160;

function remainingOf(vaultLamports) {
  if (vaultLamports == null) return MAX_TVL;
  const vault = typeof vaultLamports === 'bigint' ? vaultLamports : BigInt(vaultLamports);
  if (vault < 0n) throw new Error('vaultLamports must be an integer');
  if (vault >= MAX_TVL) return 0n;
  return MAX_TVL - vault;
}

function shieldLimits(opts = {}) {
  const omitted = opts.vaultLamports == null || opts.vaultLamports === '';
  const remaining = remainingOf(omitted ? null : opts.vaultLamports);
  const vault = omitted ? null : BigInt(opts.vaultLamports);
  return {
    programId: PROGRAM_ID,
    label: 'Clawd Shield',
    assetId: ASSET_ID,
    levels: LEVELS,
    maxDeposit: MAX_DEPOSIT.toString(),
    maxTvl: MAX_TVL.toString(),
    remainingTvl: remaining.toString(),
    vaultLamports: vault == null ? null : vault.toString(),
  };
}

module.exports = {
  PROGRAM_ID,
  LAMPORTS,
  MAX_DEPOSIT,
  MAX_TVL,
  LEVELS,
  ASSET_ID,
  ROOT_HISTORY,
  MAX_ENC_LEN,
  shieldLimits,
};
