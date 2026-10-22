const test = require('node:test');
const assert = require('node:assert/strict');
const { Keypair, PublicKey, SystemProgram, Transaction } = require('@solana/web3.js');
const pay = require('../lib/payments');

function transferTx({ facilitator, payer, destinations, signFacilitator = false }) {
  const tx = new Transaction({
    feePayer: facilitator.publicKey,
    recentBlockhash: Keypair.generate().publicKey.toBase58(),
  });
  for (const row of destinations) {
    tx.add(SystemProgram.transfer({
      fromPubkey: payer.publicKey,
      toPubkey: new PublicKey(row.to),
      lamports: Number(row.lamports),
    }));
  }
  if (signFacilitator) tx.partialSign(payer, facilitator);
  else tx.partialSign(payer);
  return tx.serialize({ requireAllSignatures: false, verifySignatures: false });
}

test('supported kinds name clawd exact, x402, and mpp', () => {
  const kinds = pay.supportedKinds().kinds;
  assert.deepEqual(kinds.map(k => k.network), ['clawd', 'clawd', 'clawd']);
  assert.deepEqual(kinds.map(k => k.scheme), ['exact', 'x402', 'mpp']);
});

test('challenge parse keeps amount, payTo, and nonce', () => {
  const facilitator = Keypair.generate();
  const payTo = Keypair.generate();
  const challenge = pay.buildChallenge({
    scheme: 'exact',
    amount: '1000',
    payTo: payTo.publicKey,
    feePayer: facilitator.publicKey,
    nonce: 'nonce-exact-1',
    resource: '/resource',
  });
  const http = pay.unpaidHttp(challenge);
  assert.equal(http.status, 402);
  assert.equal(http.body.amount, '1000');
  assert.equal(http.body.payTo, payTo.publicKey.toBase58());
  assert.equal(http.body.nonce, 'nonce-exact-1');
  const raw = JSON.stringify(http);
  assert.equal(raw.includes(pay.PROTECTED_RESOURCE), false);
  console.log('a 402 response lacks the protected body');
  const parsed = pay.parseChallenge(JSON.stringify(http.body));
  assert.equal(parsed.ok, true);
  assert.equal(parsed.challenge.amount, '1000');
  assert.equal(parsed.challenge.payTo, payTo.publicKey.toBase58());
  assert.equal(parsed.challenge.nonce, 'nonce-exact-1');
  assert.equal(parsed.challenge.feePayer, facilitator.publicKey.toBase58());
  const missing = pay.parseChallenge({ scheme: 'exact', network: 'clawd', payTo: payTo.publicKey.toBase58() });
  assert.equal(missing.ok, false);
  assert.equal(pay.parseChallenge({ scheme: 'exact', network: 'solana', amount: '1', payTo: payTo.publicKey.toBase58(), nonce: 'n', feePayer: facilitator.publicKey.toBase58() }).ok, false);
});

test('/verify does not change balances and a valid payment releases the resource once', () => {
  const facilitator = Keypair.generate();
  const payer = Keypair.generate();
  const payTo = Keypair.generate();
  const challenge = pay.buildChallenge({
    scheme: 'x402',
    amount: 2500,
    payTo: payTo.publicKey,
    feePayer: facilitator.publicKey,
    nonce: 'nonce-verify-1',
    resource: '/resource',
  });
  const raw = transferTx({
    facilitator,
    payer,
    destinations: [{ to: payTo.publicKey.toBase58(), lamports: challenge.amount }],
  });
  const payment = pay.buildPayment({ challenge, transaction: raw });
  const header = pay.encodePaymentHeader(payment);
  const read = pay.readPaymentHeader({ 'X-PAYMENT': header });
  assert.equal(read.ok, true);
  const balances = Object.freeze({
    [payer.publicKey.toBase58()]: '9000000000',
    [payTo.publicKey.toBase58()]: '0',
    [facilitator.publicKey.toBase58()]: '1000000000',
  });
  const seen = pay.createSeenPayments();
  const beforeSeen = seen.size;
  const verdict = pay.verifyPayment({ challenge, payment: read.payment, seen, balances });
  assert.equal(verdict.ok, true);
  assert.equal(verdict.movesFunds, false);
  assert.equal(verdict.submit, false);
  assert.equal(verdict.feePayer, facilitator.publicKey.toBase58());
  assert.notEqual(verdict.feePayer, verdict.payer);
  assert.equal(verdict.facilitatorSigned, false);
  assert.equal(seen.size, beforeSeen);
  assert.equal(balances[payer.publicKey.toBase58()], '9000000000');
  console.log('/verify does not change balances');

  const intent = pay.settleIntent({ challenge, payment: header, seen, balances });
  assert.equal(intent.submit, true);
  assert.equal(intent.movesFunds, false);
  assert.equal(seen.size, beforeSeen);
  assert.equal(balances[facilitator.publicKey.toBase58()], '1000000000');

  const access = pay.decideAccess({
    challenge,
    payment: header,
    seen,
    resource: pay.PROTECTED_RESOURCE,
  });
  assert.equal(access.status, 200);
  assert.equal(access.body, pay.PROTECTED_RESOURCE);
  assert.equal(access.released, true);
  const echoed = JSON.parse(Buffer.from(access.headers['x-payment-response'], 'base64').toString('utf8'));
  assert.equal(echoed.feePayer, facilitator.publicKey.toBase58());
  assert.equal(echoed.split[0].amount, '2500');
  console.log('a valid replay contains it');
  console.log(access.body);

  seen.add(intent.nonce, intent.payerSignature);
  const replay = pay.decideAccess({
    challenge,
    payment: header,
    seen,
    resource: pay.PROTECTED_RESOURCE,
  });
  assert.equal(replay.status, 402);
  assert.equal(replay.released, false);
  assert.equal(replay.reason, 'replayed proof');
  assert.equal(JSON.stringify(replay.body).includes(pay.PROTECTED_RESOURCE), false);
  console.log('replayed proof does not release the resource');

  seen.release(intent.nonce, intent.payerSignature);
  const afterRelease = pay.verifyPayment({ challenge, payment: header, seen, balances });
  assert.equal(afterRelease.ok, true);
  assert.equal(seen.has(intent.nonce, intent.payerSignature), false);
});

test('a bad proof does not release the resource', () => {
  const facilitator = Keypair.generate();
  const payer = Keypair.generate();
  const payTo = Keypair.generate();
  const other = Keypair.generate();
  const challenge = pay.buildChallenge({
    amount: '4000',
    payTo: payTo.publicKey,
    feePayer: facilitator.publicKey,
    nonce: 'nonce-bad-1',
  });
  const wrongAmount = transferTx({
    facilitator,
    payer,
    destinations: [{ to: payTo.publicKey.toBase58(), lamports: '3999' }],
  });
  const bad = pay.decideAccess({
    challenge,
    payment: pay.buildPayment({ challenge, transaction: wrongAmount }),
    seen: pay.createSeenPayments(),
    resource: pay.PROTECTED_RESOURCE,
  });
  assert.equal(bad.status, 402);
  assert.equal(bad.reason, 'payment does not match the challenge');
  assert.equal(JSON.stringify(bad.body).includes(pay.PROTECTED_RESOURCE), false);

  const wrongDest = transferTx({
    facilitator,
    payer,
    destinations: [{ to: other.publicKey.toBase58(), lamports: '4000' }],
  });
  const dest = pay.verifyPayment({
    challenge,
    payment: pay.buildPayment({ challenge, transaction: wrongDest }),
  });
  assert.equal(dest.ok, false);

  const unsigned = new Transaction({
    feePayer: facilitator.publicKey,
    recentBlockhash: Keypair.generate().publicKey.toBase58(),
  });
  unsigned.add(SystemProgram.transfer({
    fromPubkey: payer.publicKey,
    toPubkey: payTo.publicKey,
    lamports: 4000,
  }));
  const unsignedRaw = unsigned.serialize({ requireAllSignatures: false, verifySignatures: false });
  const noSig = pay.verifyPayment({
    challenge,
    payment: pay.buildPayment({ challenge, transaction: unsignedRaw }),
  });
  assert.equal(noSig.ok, false);
  assert.equal(noSig.reason, 'payer signature required');

  const raw = Buffer.from(transferTx({
    facilitator,
    payer,
    destinations: [{ to: payTo.publicKey.toBase58(), lamports: '4000' }],
  }));
  raw[1 + 64 + 63] ^= 0xff;
  const tampered = pay.verifyPayment({
    challenge,
    payment: pay.buildPayment({ challenge, transaction: raw }),
  });
  assert.equal(tampered.ok, false);
  assert.equal(tampered.reason, 'bad signature');

  const selfPaid = new Transaction({
    feePayer: payer.publicKey,
    recentBlockhash: Keypair.generate().publicKey.toBase58(),
  });
  selfPaid.add(SystemProgram.transfer({
    fromPubkey: payer.publicKey,
    toPubkey: payTo.publicKey,
    lamports: 4000,
  }));
  selfPaid.partialSign(payer);
  const sameWallet = pay.verifyPayment({
    challenge: pay.buildChallenge({
      amount: '4000',
      payTo: payTo.publicKey,
      feePayer: payer.publicKey,
      nonce: 'nonce-same-wallet',
    }),
    payment: pay.buildPayment({
      challenge: pay.buildChallenge({
        amount: '4000',
        payTo: payTo.publicKey,
        feePayer: payer.publicKey,
        nonce: 'nonce-same-wallet',
      }),
      transaction: selfPaid.serialize({ requireAllSignatures: false, verifySignatures: false }),
    }),
  });
  assert.equal(sameWallet.ok, false);
  assert.equal(sameWallet.reason, 'fee payer must be distinct from the paying wallet');
});

test('mpp split pays both recipients their stated amounts', () => {
  const facilitator = Keypair.generate();
  const payer = Keypair.generate();
  const first = Keypair.generate();
  const second = Keypair.generate();
  const quoted = pay.quoteSplit([
    { address: first.publicKey, amount: '700' },
    { address: second.publicKey, amount: '300' },
  ]);
  assert.equal(quoted.ok, true);
  assert.equal(quoted.total, '1000');
  const challenge = pay.buildChallenge({
    scheme: 'mpp',
    recipients: quoted.recipients,
    feePayer: facilitator.publicKey,
    nonce: 'nonce-mpp-1',
    resource: '/resource',
  });
  assert.equal(challenge.amount, '1000');
  assert.equal(challenge.recipients.length, 2);
  const http = pay.unpaidHttp(challenge);
  assert.equal(http.status, 402);
  assert.equal(JSON.stringify(http.body).includes(pay.PROTECTED_RESOURCE), false);
  const raw = transferTx({
    facilitator,
    payer,
    destinations: [
      { to: first.publicKey.toBase58(), lamports: '700' },
      { to: second.publicKey.toBase58(), lamports: '300' },
    ],
    signFacilitator: true,
  });
  const payment = pay.buildPayment({ challenge, transaction: raw });
  const balances = Object.freeze({ [payer.publicKey.toBase58()]: '5000' });
  const verdict = pay.verifyPayment({ challenge: http.body, payment, balances });
  assert.equal(verdict.ok, true);
  assert.equal(verdict.movesFunds, false);
  assert.equal(verdict.facilitatorSigned, true);
  assert.notEqual(verdict.feePayer, verdict.payer);
  assert.equal(balances[payer.publicKey.toBase58()], '5000');
  const accounted = pay.applyTransferAccounting(
    { [verdict.payer]: '5000', [verdict.feePayer]: '10' },
    verdict.transfers,
  );
  assert.equal(accounted.ok, true);
  assert.equal(accounted.balances[verdict.feePayer], '10');
  assert.equal(verdict.split.length, 2);
  for (const part of verdict.split) {
    assert.equal(accounted.balances[part.address], part.amount);
    console.log(`split recipient ${part.address} received ${accounted.balances[part.address]}`);
  }
  console.log('both split recipients receive their amounts');
  console.log(`fee payer ${verdict.feePayer} is distinct from paying wallet ${verdict.payer}`);

  const swapped = transferTx({
    facilitator,
    payer,
    destinations: [
      { to: first.publicKey.toBase58(), lamports: '500' },
      { to: second.publicKey.toBase58(), lamports: '500' },
    ],
  });
  const mismatch = pay.verifyPayment({
    challenge,
    payment: pay.buildPayment({ challenge, transaction: swapped }),
  });
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.reason, 'payment does not match the challenge');
  assert.equal(pay.quoteSplit([{ address: first.publicKey, amount: '1' }, { address: first.publicKey, amount: '1' }]).ok, false);
  assert.throws(() => pay.buildChallenge({ scheme: 'mpp', recipients: [{ address: first.publicKey, amount: '5' }], feePayer: facilitator.publicKey }), pay.PaymentError);
});
