const test = require('node:test');
const assert = require('node:assert/strict');
const far = require('../chain/far');
const chain = require('../chain');
const { generateIdentity, publicKeyHex } = require('../chain/sign');

function person() {
  const identity = generateIdentity();
  return { identity, publicKey: publicKeyHex(identity.publicKey), privateKey: identity.privateKey };
}

function balancesOf(book, ids, assets) {
  const out = {};
  for (const id of ids) {
    out[id] = {};
    for (const asset of assets) out[id][asset] = far.balance(book, id, asset);
  }
  return out;
}

test('a scoped key cannot act for another account, key, or method', () => {
  const book = far.createFar();
  assert.equal(chain.createFar, far.createFar);
  assert.equal(chain.farCall, far.functionCall);
  assert.equal(chain.addFarKey, far.addKey);
  const alice = person();
  const bob = person();
  const app = person();
  const scoped = person();
  assert.equal(far.createAccount(book, {
    accountId: 'alice.clawd', publicKey: alice.publicKey, shard: 'shard-0', balances: { CLAWD: 100n },
  }).ok, true);
  assert.equal(far.createAccount(book, {
    accountId: 'bob.clawd', publicKey: bob.publicKey, shard: 'shard-0', balances: { CLAWD: 40n },
  }).ok, true);
  assert.equal(far.createAccount(book, {
    accountId: 'app.clawd', publicKey: app.publicKey, shard: 'shard-0', balances: { CLAWD: 1n },
  }).ok, true);
  const granted = far.addKey(book, {
    accountId: 'alice.clawd',
    signerPublicKey: alice.publicKey,
    signerPrivateKey: alice.privateKey,
    publicKey: scoped.publicKey,
    permission: { kind: 'functionCall', receiverId: 'app.clawd', methodNames: ['ping'] },
    nonce: 1n,
  });
  assert.equal(granted.ok, true);

  const ping = far.functionCall(book, {
    accountId: 'alice.clawd',
    publicKey: scoped.publicKey,
    privateKey: scoped.privateKey,
    receiverId: 'app.clawd',
    method: 'ping',
    nonce: 1n,
  });
  assert.equal(ping.ok, true);
  assert.equal(ping.calls, 1n);
  const ids = ['alice.clawd', 'bob.clawd', 'app.clawd'];
  const afterGrant = balancesOf(book, ids, ['CLAWD']);
  assert.equal(afterGrant['alice.clawd'].CLAWD, 100n);
  assert.equal(afterGrant['bob.clawd'].CLAWD, 40n);
  assert.equal(afterGrant['app.clawd'].CLAWD, 1n);

  const rejected = [
    far.functionCall(book, {
      accountId: 'alice.clawd', publicKey: scoped.publicKey, privateKey: scoped.privateKey,
      receiverId: 'app.clawd', method: 'burn', nonce: 2n,
    }),
    far.functionCall(book, {
      accountId: 'alice.clawd', publicKey: scoped.publicKey, privateKey: scoped.privateKey,
      receiverId: 'bob.clawd', method: 'ping', nonce: 2n,
    }),
    far.functionCall(book, {
      accountId: 'alice.clawd', publicKey: scoped.publicKey, privateKey: scoped.privateKey,
      receiverId: 'app.clawd', method: 'ping', deposit: 5n, nonce: 2n,
    }),
    far.transfer(book, {
      accountId: 'alice.clawd', publicKey: scoped.publicKey, privateKey: scoped.privateKey,
      receiverId: 'bob.clawd', amount: 5n, nonce: 2n,
    }),
    far.functionCall(book, {
      accountId: 'alice.clawd', publicKey: bob.publicKey, privateKey: bob.privateKey,
      receiverId: 'app.clawd', method: 'ping', nonce: 1n,
    }),
    far.functionCall(book, {
      accountId: 'bob.clawd', publicKey: alice.publicKey, privateKey: alice.privateKey,
      receiverId: 'app.clawd', method: 'ping', nonce: 1n,
    }),
    far.functionCall(book, {
      accountId: 'carol.clawd', publicKey: alice.publicKey, privateKey: alice.privateKey,
      receiverId: 'app.clawd', method: 'ping', nonce: 1n,
    }),
  ];
  assert.deepEqual(rejected.map(result => result.reason), ['scope', 'scope', 'scope', 'scope', 'key', 'key', 'account']);
  assert.equal(book.accounts.get('app.clawd').calls, 1n);
  assert.deepEqual(balancesOf(book, ids, ['CLAWD']), afterGrant);

  const again = far.functionCall(book, {
    accountId: 'alice.clawd', publicKey: scoped.publicKey, privateKey: scoped.privateKey,
    receiverId: 'app.clawd', method: 'ping', nonce: 2n,
  });
  assert.equal(again.ok, true);
  assert.equal(again.calls, 2n);
  assert.deepEqual(balancesOf(book, ids, ['CLAWD']), afterGrant);
  console.log(`scoped ping calls ${again.calls} alice ${afterGrant['alice.clawd'].CLAWD}`);
});

test('two shards stay isolated, receipts are atomic, and inclusion is final', async () => {
  const book = far.createFar();
  const maker = (name, shard, amount) => {
    const who = person();
    const opened = far.createAccount(book, {
      accountId: name, publicKey: who.publicKey, shard, balances: { CLAWD: amount },
    });
    assert.equal(opened.ok, true);
    return who;
  };
  const alice = maker('alice.clawd', 'shard-0', 80n);
  const bob = maker('bob.clawd', 'shard-0', 0n);
  const carol = maker('carol.clawd', 'shard-1', 20n);
  const dave = maker('dave.clawd', 'shard-1', 0n);
  maker('miner.clawd', 'shard-1', 0n);
  const quietBefore = far.quoteShard(book, 'shard-1');
  assert.equal(far.setShard(book, 'shard-0', { fee: 50n, capacity: 1 }).ok, true);
  assert.equal(far.fillQueue(book, 'shard-0', 1).ok, true);
  const quietAfter = far.quoteShard(book, 'shard-1');
  const busy = far.quoteShard(book, 'shard-0');
  assert.equal(quietAfter.fee, quietBefore.fee);
  assert.equal(quietAfter.delay, quietBefore.delay);
  assert.equal(quietAfter.queued, quietBefore.queued);
  assert.equal(busy.fee, 50n);
  assert.equal(quietAfter.fee, 1n);
  assert.ok(busy.delay > quietAfter.delay);

  const commit = await far.commitShards(book, {
    plans: [
      { shard: 'shard-0', actions: [{ accountId: 'alice.clawd', publicKey: alice.publicKey, privateKey: alice.privateKey, receiverId: 'bob.clawd', amount: 4n, nonce: 1n }] },
      { shard: 'shard-1', actions: [{ accountId: 'carol.clawd', publicKey: carol.publicKey, privateKey: carol.privateKey, receiverId: 'dave.clawd', amount: 4n, nonce: 1n }] },
    ],
    unitsPerAction: 0,
  });
  assert.equal(commit.ok, true);
  const shard0 = commit.applied.find(item => item.shard === 'shard-0');
  const shard1 = commit.applied.find(item => item.shard === 'shard-1');
  assert.equal(shard0.ok, false);
  assert.equal(shard0.reason, 'queue');
  assert.equal(shard0.fee, 50n);
  assert.equal(shard1.ok, true);
  assert.equal(shard1.fee, 1n);
  assert.equal(shard1.results[0].fee, 1n);
  assert.equal(far.balance(book, 'alice.clawd'), 80n);
  assert.equal(far.balance(book, 'bob.clawd'), 0n);
  assert.equal(far.balance(book, 'carol.clawd'), 15n);
  assert.equal(far.balance(book, 'dave.clawd'), 4n);
  assert.equal(far.quoteShard(book, 'shard-1').fee, quietBefore.fee);
  assert.equal(far.quoteShard(book, 'shard-1').delay, quietBefore.delay);

  const receiptBook = far.createFar();
  const payer = person();
  const left = person();
  const right = person();
  far.createAccount(receiptBook, { accountId: 'payer.clawd', publicKey: payer.publicKey, shard: 'shard-0', balances: { CLAWD: 30n } });
  far.createAccount(receiptBook, { accountId: 'left.clawd', publicKey: left.publicKey, shard: 'shard-1', balances: { CLAWD: 0n } });
  far.createAccount(receiptBook, { accountId: 'right.clawd', publicKey: right.publicKey, shard: 'shard-1', balances: { CLAWD: 0n } });
  const landed = far.applyReceipt(receiptBook, {
    transfers: [
      { from: 'payer.clawd', to: 'left.clawd', amount: 10n },
      { from: 'payer.clawd', to: 'right.clawd', amount: 5n },
    ],
  });
  assert.equal(landed.ok, true);
  assert.deepEqual(landed.shards.sort(), ['shard-0', 'shard-1']);
  const over = far.applyReceipt(receiptBook, {
    transfers: [
      { from: 'payer.clawd', to: 'left.clawd', amount: 10n },
      { from: 'payer.clawd', to: 'right.clawd', amount: 10n },
    ],
  });
  assert.equal(over.ok, false);
  assert.equal(over.reason, 'balance');
  assert.equal(far.balance(receiptBook, 'payer.clawd'), 15n);
  assert.equal(far.balance(receiptBook, 'left.clawd'), 10n);
  assert.equal(far.balance(receiptBook, 'right.clawd'), 5n);
  console.log(`receipt payer ${far.balance(receiptBook, 'payer.clawd')} left ${far.balance(receiptBook, 'left.clawd')} right ${far.balance(receiptBook, 'right.clawd')}`);

  async function batch(label, plans) {
    const timed = far.createFar();
    const a = person();
    const b = person();
    const c = person();
    const d = person();
    far.createAccount(timed, { accountId: 'a.clawd', publicKey: a.publicKey, shard: 'shard-0', balances: { CLAWD: 20n } });
    far.createAccount(timed, { accountId: 'b.clawd', publicKey: b.publicKey, shard: 'shard-0', balances: { CLAWD: 0n } });
    far.createAccount(timed, { accountId: 'c.clawd', publicKey: c.publicKey, shard: 'shard-1', balances: { CLAWD: 20n } });
    far.createAccount(timed, { accountId: 'd.clawd', publicKey: d.publicKey, shard: 'shard-1', balances: { CLAWD: 0n } });
    const actions = {
      'shard-0': { accountId: 'a.clawd', publicKey: a.publicKey, privateKey: a.privateKey, receiverId: 'b.clawd', amount: 1n, nonce: 1n },
      'shard-1': { accountId: 'c.clawd', publicKey: c.publicKey, privateKey: c.privateKey, receiverId: 'd.clawd', amount: 1n, nonce: 1n },
    };
    const second = { ...actions['shard-0'], nonce: 2n };
    const concrete = plans.map(shard => ({
      shard,
      actions: shard === 'shard-0' && plans.length === 1 ? [actions['shard-0'], second] : [actions[shard]],
    }));
    const result = await far.commitShards(timed, { plans: concrete, unitsPerAction: far.SPEED_UNITS });
    assert.equal(result.ok, true);
    for (const item of result.applied) assert.equal(item.ok, true, label);
    return result;
  }
  const oneShard = await batch('one', ['shard-0']);
  const twoShards = await batch('two', ['shard-0', 'shard-1']);
  assert.ok(twoShards.elapsedNs < oneShard.elapsedNs);
  console.log(`one shard ${oneShard.elapsedNs} two shards ${twoShards.elapsedNs}`);

  assert.equal(far.isFinal(book, commit.chunkId).final, false);
  const held = balancesOf(book, ['alice.clawd', 'bob.clawd', 'carol.clawd', 'dave.clawd'], ['CLAWD']);
  const produced = far.produceBlock(book, { producer: 'miner.clawd', chunkIds: [commit.chunkId] });
  assert.equal(produced.ok, true);
  assert.equal(produced.block.final, true);
  assert.equal(produced.block.confirmations, 1);
  const finalChunk = far.isFinal(book, commit.chunkId);
  assert.equal(finalChunk.final, true);
  assert.equal(finalChunk.confirmations, 1);
  assert.equal(far.dropBlock(book, produced.block.height).reason, 'final');
  assert.equal(far.produceBlock(book, { producer: 'miner.clawd', chunkIds: [commit.chunkId] }).reason, 'final');
  far.produceBlock(book, { producer: 'miner.clawd' });
  assert.deepEqual(balancesOf(book, ['alice.clawd', 'bob.clawd', 'carol.clawd', 'dave.clawd'], ['CLAWD']), held);
  console.log(`final height ${produced.block.height} confirmations ${produced.block.confirmations}`);
});

test('solvers settle a signed intent only when every asset nets to zero', () => {
  const book = far.createFar();
  assert.equal(chain.settleIntents, far.settle);
  assert.equal(far.setTime(book, 10n).ok, true);
  const alice = person();
  const solverA = person();
  const solverB = person();
  const sink = person();
  far.createAccount(book, { accountId: 'alice.clawd', publicKey: alice.publicKey, shard: 'shard-0', balances: { CLAWD: 100n } });
  far.createAccount(book, { accountId: 'solver-a.clawd', publicKey: solverA.publicKey, shard: 'shard-1', balances: { WIDGET: 1n } });
  far.createAccount(book, { accountId: 'solver-b.clawd', publicKey: solverB.publicKey, shard: 'shard-1', balances: { WIDGET: 1n } });
  far.createAccount(book, { accountId: 'fee.clawd', publicKey: sink.publicKey, shard: 'shard-0', balances: { CLAWD: 0n } });
  assert.equal(book.accounts.get('alice.clawd').gas, undefined);

  const routed = far.signIntent(alice.privateKey, alice.publicKey, {
    signerId: 'alice.clawd',
    diffs: [{ asset: 'CLAWD', amount: -100n }, { asset: 'WIDGET', amount: 1n }],
    deadline: 50n,
    nonce: 1n,
    route: 'amm',
  });
  assert.equal(routed.ok, false);
  assert.equal(routed.reason, 'route');

  const signed = far.signIntent(alice.privateKey, alice.publicKey, {
    signerId: 'alice.clawd',
    diffs: [{ asset: 'CLAWD', amount: -100n }, { asset: 'WIDGET', amount: 1n }],
    deadline: 50n,
    nonce: 1n,
  });
  assert.equal(signed.ok, true);
  assert.equal(signed.intent.body.includes('route'), false);
  const submitted = far.submitIntent(book, signed.intent);
  assert.equal(submitted.ok, true);
  const fillA = far.signFill(solverA.privateKey, solverA.publicKey, {
    solverId: 'solver-a.clawd', intentId: submitted.intentId,
    diffs: [{ asset: 'CLAWD', amount: 100n }, { asset: 'WIDGET', amount: -1n }],
    deadline: 50n, nonce: 1n,
  });
  const fillB = far.signFill(solverB.privateKey, solverB.publicKey, {
    solverId: 'solver-b.clawd', intentId: submitted.intentId,
    diffs: [{ asset: 'CLAWD', amount: 90n }, { asset: 'WIDGET', amount: -1n }],
    deadline: 50n, nonce: 1n,
  });
  const idA = far.submitFill(book, fillA.fill);
  const idB = far.submitFill(book, fillB.fill);
  assert.equal(idA.ok, true);
  assert.equal(idB.ok, true);
  const ids = ['alice.clawd', 'solver-a.clawd', 'solver-b.clawd', 'fee.clawd'];
  const assets = ['CLAWD', 'WIDGET'];
  const before = balancesOf(book, ids, assets);

  const mismatched = far.settle(book, {
    intentId: submitted.intentId,
    fillId: idA.fillId,
    sink: { accountId: 'fee.clawd', diffs: [{ asset: 'CLAWD', amount: 10n }] },
  });
  assert.equal(mismatched.ok, false);
  assert.equal(mismatched.reason, 'net');
  assert.deepEqual(balancesOf(book, ids, assets), before);

  const forged = { ...signed.intent, signature: signed.intent.signature.slice(0, -2) + '00' };
  assert.equal(far.submitIntent(book, forged).reason, 'signature');
  assert.deepEqual(balancesOf(book, ids, assets), before);

  const settled = far.settle(book, {
    intentId: submitted.intentId,
    fillId: idB.fillId,
    sink: { accountId: 'fee.clawd', diffs: [{ asset: 'CLAWD', amount: 10n }] },
  });
  assert.equal(settled.ok, true);
  assert.equal(far.balance(book, 'alice.clawd', 'CLAWD'), 0n);
  assert.equal(far.balance(book, 'alice.clawd', 'WIDGET'), 1n);
  assert.equal(far.balance(book, 'solver-b.clawd', 'CLAWD'), 90n);
  assert.equal(far.balance(book, 'solver-b.clawd', 'WIDGET'), 0n);
  assert.equal(far.balance(book, 'solver-a.clawd', 'CLAWD'), 0n);
  assert.equal(far.balance(book, 'solver-a.clawd', 'WIDGET'), 1n);
  assert.equal(far.balance(book, 'fee.clawd', 'CLAWD'), 10n);
  assert.equal(book.accounts.get('alice.clawd').gas, undefined);
  const supply = ['alice.clawd', 'solver-a.clawd', 'solver-b.clawd', 'fee.clawd']
    .reduce((sum, id) => sum + far.balance(book, id, 'CLAWD'), 0n);
  assert.equal(supply, 100n);

  far.setTime(book, 80n);
  const late = far.signIntent(alice.privateKey, alice.publicKey, {
    signerId: 'alice.clawd',
    diffs: [{ asset: 'CLAWD', amount: -1n }],
    deadline: 20n,
    nonce: 2n,
  });
  assert.equal(far.submitIntent(book, late.intent).reason, 'deadline');
  assert.equal(far.balance(book, 'alice.clawd', 'WIDGET'), 1n);
  console.log(`settled alice widget ${far.balance(book, 'alice.clawd', 'WIDGET')} fee ${far.balance(book, 'fee.clawd')}`);
});

test('included model work pays CLAWD only to that block producer', () => {
  const book = far.createFar();
  assert.equal(chain.produceBlock, far.produceBlock);
  assert.equal(chain.chargeFor, far.chargeFor);
  const charges = {};
  for (const kind of far.WORK_KINDS) {
    charges[kind] = far.chargeFor(kind);
    assert.equal(typeof charges[kind], 'bigint');
    assert.ok(charges[kind] > 0n);
  }
  const open = (name, amount) => {
    const who = person();
    assert.equal(far.createAccount(book, {
      accountId: name, publicKey: who.publicKey, shard: 'shard-0', balances: { CLAWD: amount },
    }).ok, true);
  };
  open('alice.clawd', charges.authentication + charges.attestation);
  open('carol.clawd', charges.inference);
  open('bob.clawd', 50n);
  open('broke.clawd', 0n);
  open('miner.clawd', 0n);
  open('other.clawd', 0n);
  assert.equal(far.mined(book, 'miner.clawd'), 0n);
  const produced = far.produceBlock(book, {
    producer: 'miner.clawd',
    work: [
      { kind: 'authentication', payer: 'alice.clawd', outcome: 'ok' },
      { kind: 'attestation', payer: 'alice.clawd', outcome: 'ok' },
      { kind: 'verification', payer: 'bob.clawd', outcome: 'failed' },
      { kind: 'inference', payer: 'carol.clawd', outcome: 'ok' },
      { kind: 'inference', payer: 'broke.clawd', outcome: 'ok' },
      { kind: 'not-a-model', payer: 'bob.clawd', outcome: 'ok' },
    ],
  });
  assert.equal(produced.ok, true);
  assert.equal(produced.block.final, true);
  assert.equal(produced.block.confirmations, 1);
  const reward = charges.authentication + charges.attestation + charges.inference;
  assert.equal(produced.block.reward, reward);
  assert.equal(produced.mined, reward);
  assert.equal(far.mined(book, 'miner.clawd'), reward);
  assert.equal(far.mined(book, 'other.clawd'), 0n);
  assert.equal(far.balance(book, 'miner.clawd'), reward);
  assert.equal(far.balance(book, 'alice.clawd'), 0n);
  assert.equal(far.balance(book, 'carol.clawd'), 0n);
  assert.equal(far.balance(book, 'bob.clawd'), 50n);
  assert.equal(far.balance(book, 'broke.clawd'), 0n);
  const applied = produced.block.included.filter(item => item.applied).map(item => item.kind);
  assert.deepEqual(applied, ['authentication', 'attestation', 'inference']);
  console.log(`mined ${produced.mined} kinds ${applied.join(',')}`);
});
