const test = require('node:test');
const assert = require('node:assert/strict');
const { Keypair: SolKey } = require('@solana/web3.js');
const { label } = require('../brain/format');
const { PROGRAMS } = require('../api/lib/programs');
const shield = require('../chain/shield');

test('shield pool accepts one Groth16 deposit and rejects replay, a bad proof, and the deposit cap', { timeout: 300000 }, async () => {
  assert.equal(PROGRAMS.shield, shield.PROGRAM_ID);
  assert.equal(label(PROGRAMS.shield), `Clawd Shield (${shield.PROGRAM_ID})`);
  assert.equal(shield.MAX_DEPOSIT, 100_000_000_000n);
  assert.equal(shield.MAX_TVL, 10_000_000_000_000n);

  const pool = await shield.createPool();
  const S = shield.loadSdk();
  const root = pool.tree.root().toString();
  const recipient = SolKey.generate().publicKey.toBase58();
  const ext = {
    recipient,
    relayer: recipient,
    enc1: Buffer.alloc(1),
    enc2: Buffer.alloc(1),
  };

  pool.paused = true;
  const paused = await shield.transact(pool, { publicSignals: [root, '0', '0', '2', '3', '4', '5', '1'], proof: {}, ext });
  assert.equal(paused.ok, false);
  assert.equal(paused.reason, 'paused');
  pool.paused = false;

  const unknown = await shield.transact(pool, {
    publicSignals: ['0', '0', '0', '0', '0', '0', '0', '1'],
    proof: {},
    ext,
  });
  assert.equal(unknown.reason, 'unknown root');

  const feeOnDeposit = await shield.transact(pool, {
    publicSignals: [root, '0', '0', '2', '3', '4', '5', '1'],
    proof: {},
    ext: { ...ext, extAmount: 1000n, fee: 1n },
  });
  assert.equal(feeOnDeposit.reason, 'bad amount');

  const overCap = await shield.transact(pool, {
    publicSignals: [root, '0', '0', '2', '3', '4', '5', '1'],
    proof: {},
    ext: { ...ext, extAmount: shield.MAX_DEPOSIT + 1n, fee: 0n },
  });
  assert.equal(overCap.reason, 'deposit cap');
  assert.equal(pool.vault, 0n);

  const mismatched = await shield.transact(pool, {
    publicSignals: [root, S.fieldOf(1000n).toString(), '1', '2', '3', '4', '5', S.ASSET_ID.toString()],
    proof: {},
    ext: { ...ext, extAmount: 1000n, fee: 0n },
  });
  assert.equal(mismatched.reason, 'ext data');
  assert.equal(pool.nextIndex, 0);

  const kp = new S.Keypair();
  const amount = 5_000_000_000n;
  const out = [
    new S.Note({ amount, keypair: kp }),
    new S.Note({ amount: 0n, keypair: kp }),
  ];
  const proved = await shield.prove({
    tree: pool.tree,
    inputs: [],
    outputs: out,
    extAmount: amount,
    fee: 0n,
    recipient,
    relayer: recipient,
    encPubs: [kp.enc.publicKey, kp.enc.publicKey],
  });
  assert.equal(proved.publicSignals.length, 8);
  assert.equal(BigInt(proved.publicSignals[0]), pool.tree.root());
  assert.equal(BigInt(proved.publicSignals[7]), S.ASSET_ID);

  const clean = await shield.createPool();
  const badProof = JSON.parse(JSON.stringify(proved.proof));
  badProof.pi_a[0] = (BigInt(badProof.pi_a[0]) + 1n).toString();
  const tampered = await shield.transact(clean, { ...proved, proof: badProof });
  assert.equal(tampered.ok, false);
  assert.equal(tampered.reason, 'invalid proof');
  assert.equal(clean.vault, 0n);
  assert.equal(clean.nextIndex, 0);

  const before = pool.tree.root();
  const applied = await shield.transact(pool, proved);
  assert.equal(applied.ok, true);
  assert.equal(applied.vault, amount);
  assert.equal(pool.vault, amount);
  assert.notEqual(pool.tree.root(), before);
  assert.equal(pool.tree.indexOf(out[0].commitment()), 0);
  assert.equal(pool.tree.indexOf(out[1].commitment()), 1);

  const replay = await shield.transact(pool, proved);
  assert.equal(replay.ok, false);
  assert.equal(replay.reason, 'nullifier spent');
  assert.equal(pool.vault, amount);
  assert.equal(pool.nextIndex, 2);

  const capped = await shield.transact(pool, {
    ...proved,
    ext: { ...proved.ext, extAmount: shield.MAX_DEPOSIT + 1n, fee: 0n },
  });
  assert.equal(capped.ok, false);
  assert.equal(capped.reason, 'deposit cap');
  assert.equal(pool.vault, amount);
  if (globalThis.curve_bn128 && globalThis.curve_bn128.terminate) await globalThis.curve_bn128.terminate();
  console.log('PASS shield deposit', amount.toString(), 'replay rejected cap rejected');
});
