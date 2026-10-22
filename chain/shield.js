// Local shielded CLAWD pool. Proofs are Groth16 over the Poseidon tree in
// clawd-shield-main, checked with snarkjs against that package's verification key.
// The compressed-account tree in compress.js is a separate fail-closed SHA-256 Merkle proof.
const fs = require('fs');
const path = require('path');
const limits = require('../lib/shield-limits');

const ROOT = path.join(__dirname, '..', 'clawd-shield-main');
const WASM = path.join(ROOT, 'build', 'transact_js', 'transact.wasm');
const ZKEY = path.join(ROOT, 'build', 'transact_final.zkey');
const VK_PATH = path.join(ROOT, 'build', 'verification_key.json');
const I64_MIN = -9223372036854775808n;
const I64_MAX = 9223372036854775807n;

let sdk;
let snarkjs;
let vk;

function loadSdk() {
  if (!sdk) {
    sdk = require(path.join(ROOT, 'sdk', 'shield'));
    snarkjs = require(path.join(ROOT, 'node_modules', 'snarkjs'));
    vk = JSON.parse(fs.readFileSync(VK_PATH, 'utf8'));
  }
  return sdk;
}

function fail(reason) {
  return { ok: false, reason };
}

function parseField(value, prime) {
  let n;
  try { n = BigInt(value); } catch { return null; }
  if (n < 0n || n >= prime) return null;
  return n;
}

function asBig(value, name) {
  try { return BigInt(value); } catch { throw new Error(name); }
}

async function createPool(opts = {}) {
  const S = loadSdk();
  await S.init();
  const tree = new S.MerkleTree(S.LEVELS);
  const vault = opts.vaultLamports == null ? 0n : BigInt(opts.vaultLamports);
  if (vault < 0n) throw new Error('vaultLamports must be an integer');
  return {
    tree,
    roots: [tree.root()],
    spent: new Set(),
    vault,
    paused: false,
    nextIndex: 0,
  };
}

function remember(pool, root) {
  pool.roots.push(root);
  if (pool.roots.length > limits.ROOT_HISTORY) pool.roots.shift();
}

async function prove(args) {
  const S = loadSdk();
  await S.init();
  return S.prove({ ...args, wasm: WASM, zkey: ZKEY });
}

async function transact(pool, tx) {
  const S = loadSdk();
  if (!pool || pool.paused) return fail('paused');
  const signalsIn = tx && Array.isArray(tx.publicSignals) ? tx.publicSignals : null;
  if (!signalsIn || signalsIn.length !== 8) return fail('invalid proof');
  const signals = [];
  for (const value of signalsIn) {
    const n = parseField(value, S.FR);
    if (n == null) return fail('not in field');
    signals.push(n);
  }
  const [root, publicAmount, extHash, nf0, nf1, cm0, cm1, asset] = signals;
  if (root === 0n || !pool.roots.some(known => known === root)) return fail('unknown root');

  const ext = tx.ext || {};
  let extAmount;
  let fee;
  try {
    extAmount = asBig(ext.extAmount, 'amount');
    fee = asBig(ext.fee, 'fee');
  } catch {
    return fail('bad amount');
  }
  if (extAmount <= I64_MIN || extAmount > I64_MAX || fee < 0n || fee > limits.MAX_TVL) return fail('bad amount');
  if (extAmount > 0n) {
    if (fee !== 0n) return fail('bad amount');
    if (extAmount > limits.MAX_DEPOSIT) return fail('deposit cap');
  }
  const enc1 = ext.enc1;
  const enc2 = ext.enc2;
  if (!enc1 || !enc2 || enc1.length == null || enc2.length == null) return fail('bad amount');
  if (enc1.length > limits.MAX_ENC_LEN || enc2.length > limits.MAX_ENC_LEN) return fail('encrypted output too long');

  if (publicAmount !== S.fieldOf(extAmount - fee)) return fail('public amount');
  let hash;
  try {
    hash = S.extDataHash({
      recipient: ext.recipient,
      relayer: ext.relayer,
      extAmount,
      fee,
      enc1,
      enc2,
    });
  } catch {
    return fail('bad amount');
  }
  if (extHash !== hash) return fail('ext data');
  if (asset !== S.ASSET_ID) return fail('asset');
  if (nf0 === nf1) return fail('duplicate nullifier');
  if (pool.spent.has(nf0.toString()) || pool.spent.has(nf1.toString())) return fail('nullifier spent');
  if (pool.nextIndex + 2 > (1 << limits.LEVELS)) return fail('tree full');

  let verified = false;
  try {
    verified = await snarkjs.groth16.verify(vk, signalsIn.map(String), tx.proof);
  } catch {
    verified = false;
  }
  if (!verified) return fail('invalid proof');

  const next = pool.vault + extAmount;
  if (extAmount > 0n && next > limits.MAX_TVL) return fail('tvl cap');
  if (next < fee) return fail('bad amount');
  pool.vault = next - fee;
  pool.tree.insert(cm0);
  pool.nextIndex += 1;
  remember(pool, pool.tree.root());
  pool.tree.insert(cm1);
  pool.nextIndex += 1;
  remember(pool, pool.tree.root());
  pool.spent.add(nf0.toString());
  pool.spent.add(nf1.toString());
  return {
    ok: true,
    vault: pool.vault,
    root: pool.tree.root(),
    nullifiers: [nf0, nf1],
    commitments: [cm0, cm1],
  };
}

module.exports = {
  createPool,
  prove,
  transact,
  loadSdk,
  WASM,
  ZKEY,
  VK_PATH,
  ...limits,
};
