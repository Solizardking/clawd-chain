const test = require('node:test');
const assert = require('node:assert/strict');
const vault = require('../chain/vault');
const chain = require('../chain');

const PUMP = '8cHzQHUS2s2h8TzCmfqPKYiM4dSt4roa3n7MyRLApump';
const CLAWD = 'CLAWD';
const LOCKERS = ['alice', 'bob', 'carol'];

function balances(book) {
  const snap = { custody: {}, position: {} };
  for (const asset of [PUMP, CLAWD]) {
    snap.custody[asset] = vault.custody(book, asset);
    for (const locker of LOCKERS) {
      snap.position[`${locker}:${asset}`] = vault.position(book, { locker, asset });
    }
  }
  return snap;
}

function sumPositions(book, asset) {
  let sum = 0n;
  for (const locker of LOCKERS) sum += vault.position(book, { locker, asset });
  return sum;
}

test('lock and release keep pump and CLAWD custody isolated per locker', () => {
  const book = vault.createVault();
  assert.equal(vault.position(book, { locker: 'alice', asset: PUMP }), 0n);
  assert.equal(vault.position(book, { locker: 'alice', asset: CLAWD }), 0n);
  assert.equal(vault.custody(book, PUMP), 0n);
  assert.equal(vault.custody(book, CLAWD), 0n);
  assert.equal(chain.createVault, vault.createVault);
  assert.equal(chain.lock, vault.lock);
  assert.equal(chain.release, vault.release);

  const alicePump = vault.lock(book, { locker: 'alice', asset: PUMP, amount: 100n });
  const aliceClawd = vault.lock(book, { locker: 'alice', asset: CLAWD, amount: 80n });
  const bobPumpFirst = vault.lock(book, { locker: 'bob', asset: PUMP, amount: 30n });
  const bobPumpSecond = vault.lock(book, { locker: 'bob', asset: PUMP, amount: 20n });
  const bobClawd = vault.lock(book, { locker: 'bob', asset: CLAWD, amount: 20n });
  assert.equal(alicePump.ok, true);
  assert.equal(alicePump.locked, 100n);
  assert.equal(aliceClawd.locked, 80n);
  assert.equal(bobPumpFirst.locked, 30n);
  assert.equal(bobPumpSecond.locked, 20n);
  assert.equal(bobClawd.locked, 20n);
  assert.equal(vault.position(book, { locker: 'alice', asset: PUMP }), 100n);
  assert.equal(vault.position(book, { locker: 'bob', asset: PUMP }), 50n);
  assert.equal(vault.position(book, { locker: 'alice', asset: CLAWD }), 80n);
  assert.equal(vault.position(book, { locker: 'bob', asset: CLAWD }), 20n);
  assert.equal(vault.position(book, { locker: 'carol', asset: PUMP }), 0n);
  assert.equal(vault.custody(book, PUMP), 150n);
  assert.equal(vault.custody(book, CLAWD), 100n);
  assert.equal(vault.custody(book, PUMP), sumPositions(book, PUMP));
  assert.equal(vault.custody(book, CLAWD), sumPositions(book, CLAWD));
  console.log(`lock ${PUMP} ${alicePump.locked}`);
  console.log(`lock ${CLAWD} ${aliceClawd.locked}`);
  console.log(`lock ${PUMP} ${bobPumpFirst.locked}`);
  console.log(`lock ${PUMP} ${bobPumpSecond.locked}`);
  console.log(`lock ${CLAWD} ${bobClawd.locked}`);

  const partialPump = vault.release(book, { locker: 'alice', asset: PUMP, amount: 25n });
  assert.equal(partialPump.ok, true);
  assert.equal(partialPump.released, 25n);
  assert.equal(partialPump.position, 75n);
  assert.equal(vault.position(book, { locker: 'alice', asset: PUMP }), 75n);
  assert.equal(vault.position(book, { locker: 'bob', asset: PUMP }), 50n);
  assert.equal(vault.custody(book, PUMP), 125n);
  assert.equal(vault.custody(book, CLAWD), 100n);
  console.log(`release ${PUMP} ${partialPump.released}`);

  const restPump = vault.release(book, { locker: 'alice', asset: PUMP, amount: 75n });
  assert.equal(restPump.released, 75n);
  assert.equal(vault.position(book, { locker: 'alice', asset: PUMP }), 0n);
  assert.equal(vault.custody(book, PUMP), 50n);
  assert.equal(vault.position(book, { locker: 'alice', asset: CLAWD }), 80n);
  console.log(`release ${PUMP} ${restPump.released}`);

  const beforeRejects = balances(book);
  const over = vault.release(book, { locker: 'bob', asset: PUMP, amount: 51n });
  const zero = vault.release(book, { locker: 'alice', asset: CLAWD, amount: 0n });
  const zeroLock = vault.lock(book, { locker: 'alice', asset: PUMP, amount: 0n });
  const negative = vault.release(book, { locker: 'bob', asset: PUMP, amount: -5n });
  const fraction = vault.lock(book, { locker: 'alice', asset: CLAWD, amount: 1.5 });
  const otherLocker = vault.release(book, { locker: 'carol', asset: PUMP, amount: 50n });
  const crossAsset = vault.release(book, { locker: 'alice', asset: PUMP, amount: 80n });
  const crossOther = vault.release(book, { locker: 'bob', asset: CLAWD, amount: 50n });
  const badLock = vault.lock(book, { locker: 'alice', asset: 'USDC', amount: 10n });
  const badRelease = vault.release(book, { locker: 'bob', asset: 'USDC', amount: 10n });
  assert.equal(over.ok, false);
  assert.equal(zero.ok, false);
  assert.equal(zeroLock.ok, false);
  assert.equal(negative.ok, false);
  assert.equal(fraction.ok, false);
  assert.equal(otherLocker.ok, false);
  assert.equal(crossAsset.ok, false);
  assert.equal(crossOther.ok, false);
  assert.equal(badLock.ok, false);
  assert.equal(badRelease.ok, false);
  assert.deepEqual(balances(book), beforeRejects);
  assert.equal(vault.custody(book, 'USDC'), 0n);
  assert.equal(vault.position(book, { locker: 'alice', asset: 'USDC' }), 0n);
  assert.equal(vault.custody(book, PUMP), sumPositions(book, PUMP));
  assert.equal(vault.custody(book, CLAWD), sumPositions(book, CLAWD));

  const partialClawd = vault.release(book, { locker: 'alice', asset: CLAWD, amount: 30n });
  const restClawd = vault.release(book, { locker: 'alice', asset: CLAWD, amount: 50n });
  const bobPumpOut = vault.release(book, { locker: 'bob', asset: PUMP, amount: 50n });
  const bobClawdOut = vault.release(book, { locker: 'bob', asset: CLAWD, amount: 20n });
  assert.equal(partialClawd.released, 30n);
  assert.equal(restClawd.released, 50n);
  assert.equal(bobPumpOut.released, 50n);
  assert.equal(bobClawdOut.released, 20n);
  assert.equal(vault.position(book, { locker: 'alice', asset: CLAWD }), 0n);
  assert.equal(vault.position(book, { locker: 'bob', asset: PUMP }), 0n);
  assert.equal(vault.position(book, { locker: 'bob', asset: CLAWD }), 0n);
  assert.equal(vault.custody(book, PUMP), 0n);
  assert.equal(vault.custody(book, CLAWD), 0n);
  assert.equal(vault.custody(book, PUMP), sumPositions(book, PUMP));
  assert.equal(vault.custody(book, CLAWD), sumPositions(book, CLAWD));
  console.log(`release ${CLAWD} ${partialClawd.released}`);
  console.log(`release ${CLAWD} ${restClawd.released}`);
  console.log(`release ${PUMP} ${bobPumpOut.released}`);
  console.log(`release ${CLAWD} ${bobClawdOut.released}`);
});

test('a __proto__ locker cannot fund another locker release', () => {
  const book = vault.createVault();
  const polluted = vault.lock(book, { locker: '__proto__', asset: PUMP, amount: 100n });
  const second = vault.lock(book, { locker: 'second', asset: CLAWD, amount: 7n });
  assert.equal(polluted.ok, true);
  assert.equal(polluted.locked, 100n);
  assert.equal(second.locked, 7n);
  assert.equal(vault.position(book, { locker: '__proto__', asset: PUMP }), 100n);
  assert.equal(vault.position(book, { locker: '__proto__', asset: CLAWD }), 0n);
  assert.equal(vault.position(book, { locker: 'second', asset: PUMP }), 0n);
  assert.equal(vault.position(book, { locker: 'second', asset: CLAWD }), 7n);
  assert.equal(vault.position(book, { locker: 'constructor', asset: PUMP }), 0n);
  assert.equal(vault.custody(book, PUMP), 100n);
  assert.equal(vault.custody(book, CLAWD), 7n);
  assert.equal(({})[PUMP], undefined);

  const firstSteal = vault.release(book, { locker: 'second', asset: PUMP, amount: 100n });
  const secondSteal = vault.release(book, { locker: 'second', asset: PUMP, amount: 100n });
  assert.equal(firstSteal.ok, false);
  assert.equal(secondSteal.ok, false);
  assert.equal(vault.position(book, { locker: 'second', asset: PUMP }), 0n);
  assert.equal(vault.position(book, { locker: '__proto__', asset: PUMP }), 100n);
  assert.equal(vault.position(book, { locker: 'second', asset: CLAWD }), 7n);
  assert.equal(vault.custody(book, PUMP), 100n);
  assert.equal(vault.custody(book, CLAWD), 7n);
  assert.equal(({})[PUMP], undefined);

  const owned = vault.release(book, { locker: '__proto__', asset: PUMP, amount: 100n });
  const again = vault.release(book, { locker: '__proto__', asset: PUMP, amount: 100n });
  assert.equal(owned.ok, true);
  assert.equal(owned.released, 100n);
  assert.equal(again.ok, false);
  assert.equal(vault.position(book, { locker: '__proto__', asset: PUMP }), 0n);
  assert.equal(vault.custody(book, PUMP), 0n);
  assert.equal(vault.custody(book, CLAWD), 7n);
  assert.equal(vault.position(book, { locker: 'second', asset: CLAWD }), 7n);
  console.log(`lock ${PUMP} ${polluted.locked}`);
  console.log(`release ${PUMP} ${owned.released}`);
});
