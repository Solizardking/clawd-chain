// Lock-and-release custody for the pump mint and the clawd chain token CLAWD.
// Positions are keyed by locker and asset. Amounts are integers. Rejected
// calls leave positions and custody unchanged.
const PUMP_MINT = '8cHzQHUS2s2h8TzCmfqPKYiM4dSt4roa3n7MyRLApump';
const CLAWD = 'CLAWD';
const ASSETS = new Set([PUMP_MINT, CLAWD]);

function createVault() {
  const custody = Object.create(null);
  custody[PUMP_MINT] = 0n;
  custody[CLAWD] = 0n;
  return {
    positions: new Map(),
    custody,
  };
}

function asLocker(locker) {
  if (typeof locker !== 'string' || locker.length === 0) return null;
  return locker;
}

function asAmount(amount) {
  if (typeof amount === 'bigint') return amount;
  if (typeof amount === 'number') {
    if (!Number.isSafeInteger(amount)) return null;
    return BigInt(amount);
  }
  if (typeof amount === 'string' && /^-?\d+$/.test(amount)) return BigInt(amount);
  return null;
}

function readAmount(byLocker, asset) {
  if (!byLocker) return 0n;
  const amount = byLocker[asset];
  return typeof amount === 'bigint' ? amount : 0n;
}

function position(vault, { locker, asset } = {}) {
  return readAmount(vault.positions.get(locker), asset);
}

function custody(vault, asset) {
  const amount = vault.custody[asset];
  return typeof amount === 'bigint' ? amount : 0n;
}

function bucket(vault, locker) {
  let byLocker = vault.positions.get(locker);
  if (!byLocker) {
    byLocker = Object.create(null);
    vault.positions.set(locker, byLocker);
  }
  return byLocker;
}

function reject(reason) {
  return { ok: false, reason };
}

function lock(vault, { locker, asset, amount } = {}) {
  const who = asLocker(locker);
  if (!who) return reject('locker');
  if (!ASSETS.has(asset)) return reject('asset');
  const value = asAmount(amount);
  if (value == null || value <= 0n) return reject('amount');
  const byLocker = bucket(vault, who);
  const next = readAmount(byLocker, asset) + value;
  byLocker[asset] = next;
  vault.custody[asset] += value;
  return { ok: true, locked: value, position: next };
}

function release(vault, { locker, asset, amount } = {}) {
  const who = asLocker(locker);
  if (!who) return reject('locker');
  if (!ASSETS.has(asset)) return reject('asset');
  const value = asAmount(amount);
  if (value == null || value <= 0n) return reject('amount');
  const byLocker = vault.positions.get(who);
  const current = readAmount(byLocker, asset);
  if (value > current) return reject('balance');
  const next = current - value;
  if (next === 0n) delete byLocker[asset];
  else byLocker[asset] = next;
  vault.custody[asset] -= value;
  return { ok: true, released: value, position: next };
}

module.exports = {
  PUMP_MINT,
  CLAWD,
  createVault,
  lock,
  release,
  position,
  custody,
};
