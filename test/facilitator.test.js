const test = require('node:test');
const assert = require('node:assert/strict');
const { Keypair, PublicKey, SystemProgram, Transaction } = require('@solana/web3.js');
const pay = require('../lib/payments');
const { createPaymentsServer, listen } = require('../payments/server');

const RPC = process.env.CLAWD_RPC || 'http://127.0.0.1:18899';

async function confirm(connection, signature) {
  const latest = await connection.getLatestBlockhash('confirmed');
  await connection.confirmTransaction({
    signature,
    blockhash: latest.blockhash,
    lastValidBlockHeight: latest.lastValidBlockHeight,
  }, 'confirmed');
}

async function airdrop(connection, pubkey, lamports) {
  const signature = await connection.requestAirdrop(pubkey, lamports);
  await confirm(connection, signature);
}

async function balance(connection, pubkey) {
  return connection.getBalance(new PublicKey(pubkey), 'confirmed');
}

function clientTransfer({ facilitator, payer, destinations, blockhash }) {
  const tx = new Transaction({ feePayer: new PublicKey(facilitator), recentBlockhash: blockhash });
  for (const row of destinations) {
    tx.add(SystemProgram.transfer({
      fromPubkey: payer.publicKey,
      toPubkey: new PublicKey(row.to),
      lamports: Number(row.lamports),
    }));
  }
  tx.partialSign(payer);
  return tx.serialize({ requireAllSignatures: false, verifySignatures: false });
}

async function feePayerOf(connection, signature) {
  const tx = await connection.getTransaction(signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
  const key = tx.transaction.message.accountKeys[0];
  return typeof key === 'string' ? key : key.toBase58();
}

test('facilitator verify does not move funds and a paid replay returns the resource', { timeout: 120000 }, async () => {
  const health = await fetch(RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getHealth' }),
  });
  const healthBody = await health.json();
  assert.equal(healthBody.result, 'ok');

  const app = createPaymentsServer({ rpc: RPC });
  const base = await listen(app);
  try {
    const supported = await fetch(`${base}/supported`).then(r => r.json());
    assert.ok(supported.kinds.some(kind => kind.scheme === 'exact' && kind.network === 'clawd'));
    assert.ok(supported.kinds.some(kind => kind.scheme === 'mpp' && kind.network === 'clawd'));
    console.log(`scheme exact network ${supported.network}`);

    const payer = Keypair.generate();
    await airdrop(app.connection, new PublicKey(supported.feePayer), 1_000_000_000);
    await airdrop(app.connection, payer.publicKey, 2_000_000_000);

    const unpaidRes = await fetch(`${base}/resource`);
    const unpaidText = await unpaidRes.text();
    assert.equal(unpaidRes.status, 402);
    assert.equal(unpaidText.includes(pay.PROTECTED_RESOURCE), false);
    const challenge = JSON.parse(unpaidText);
    assert.equal(challenge.network, 'clawd');
    assert.ok(challenge.amount && challenge.payTo && challenge.nonce);
    console.log('a 402 response lacks the protected body');
    console.log(`HTTP 402 ${unpaidText}`);

    const blockhash = (await app.connection.getLatestBlockhash('confirmed')).blockhash;
    const raw = clientTransfer({
      facilitator: supported.feePayer,
      payer,
      blockhash,
      destinations: [{ to: challenge.payTo, lamports: challenge.amount }],
    });
    const payment = pay.buildPayment({ challenge, transaction: raw });
    const before = {
      payer: await balance(app.connection, payer.publicKey),
      payTo: await balance(app.connection, challenge.payTo),
      feePayer: await balance(app.connection, supported.feePayer),
    };
    const verified = await fetch(`${base}/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ paymentPayload: payment, paymentRequirements: challenge }),
    }).then(r => r.json());
    assert.equal(verified.isValid, true);
    assert.equal(verified.movesFunds, false);
    const afterVerify = {
      payer: await balance(app.connection, payer.publicKey),
      payTo: await balance(app.connection, challenge.payTo),
      feePayer: await balance(app.connection, supported.feePayer),
    };
    assert.deepEqual(afterVerify, before);
    console.log('/verify does not change balances');

    const paidRes = await fetch(`${base}/resource`, { headers: { 'X-PAYMENT': pay.encodePaymentHeader(payment) } });
    const paidText = await paidRes.text();
    assert.equal(paidRes.status, 200, paidText);
    assert.equal(paidText, pay.PROTECTED_RESOURCE);
    console.log('a valid replay contains it');
    console.log(`HTTP 200 ${paidText}`);
    const receipt = JSON.parse(Buffer.from(paidRes.headers.get('x-payment-response'), 'base64').toString('utf8'));
    const settledFeePayer = await feePayerOf(app.connection, receipt.transaction);
    assert.equal(settledFeePayer, supported.feePayer);
    assert.notEqual(settledFeePayer, payer.publicKey.toBase58());
    console.log(`settled fee payer ${settledFeePayer}`);
    assert.equal(await balance(app.connection, challenge.payTo), before.payTo + Number(challenge.amount));
    assert.equal(await balance(app.connection, payer.publicKey), before.payer - Number(challenge.amount));

    const replay = await fetch(`${base}/resource`, { headers: { 'X-PAYMENT': pay.encodePaymentHeader(payment) } });
    const replayText = await replay.text();
    assert.equal(replay.status, 402);
    assert.equal(replayText.includes(pay.PROTECTED_RESOURCE), false);
    console.log('replayed proof does not release the resource');

    const mppRes = await fetch(`${base}/resource?scheme=mpp`);
    const mppText = await mppRes.text();
    assert.equal(mppRes.status, 402);
    assert.equal(mppText.includes(pay.PROTECTED_RESOURCE), false);
    const mpp = JSON.parse(mppText);
    assert.equal(mpp.scheme, 'mpp');
    assert.equal(mpp.recipients.length, 2);
    const mppRaw = clientTransfer({
      facilitator: supported.feePayer,
      payer,
      blockhash: (await app.connection.getLatestBlockhash('confirmed')).blockhash,
      destinations: mpp.recipients.map(row => ({ to: row.address, lamports: row.amount })),
    });
    const mppPayment = pay.buildPayment({ challenge: mpp, transaction: mppRaw });
    const mppBefore = {};
    for (const row of mpp.recipients) mppBefore[row.address] = await balance(app.connection, row.address);
    const settled = await fetch(`${base}/settle`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ paymentPayload: mppPayment, paymentRequirements: mpp }),
    });
    const settledBody = await settled.json();
    assert.equal(settled.status, 200);
    assert.equal(settledBody.success, true);
    assert.equal(await feePayerOf(app.connection, settledBody.transaction), supported.feePayer);
    assert.notEqual(settledBody.feePayer, settledBody.payer);
    for (const row of mpp.recipients) {
      const got = await balance(app.connection, row.address);
      assert.equal(got - mppBefore[row.address], Number(row.amount));
      console.log(`split recipient ${row.address} received ${got - mppBefore[row.address]}`);
    }
    console.log('both split recipients receive their amounts');
    console.log(`fee payer ${settledBody.feePayer} is distinct from paying wallet ${settledBody.payer}`);

    const again = await fetch(`${base}/settle`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ paymentPayload: mppPayment, paymentRequirements: mpp }),
    });
    const againBody = await again.json();
    assert.equal(again.status, 402);
    assert.equal(againBody.success, false);
    assert.equal(JSON.stringify(againBody).includes(pay.PROTECTED_RESOURCE), false);
    for (const row of mpp.recipients) {
      assert.equal(await balance(app.connection, row.address), mppBefore[row.address] + Number(row.amount));
    }
  } finally {
    await new Promise(resolve => app.server.close(resolve));
  }
});

function settleBody(payment, challenge) {
  return JSON.stringify({ paymentPayload: payment, paymentRequirements: challenge });
}

test('same-tick duplicate proof settles and releases once', { timeout: 120000 }, async () => {
  const health = await fetch(RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getHealth' }),
  });
  assert.equal((await health.json()).result, 'ok');

  const app = createPaymentsServer({ rpc: RPC });
  const base = await listen(app);
  try {
    const supported = await fetch(`${base}/supported`).then(r => r.json());
    const payer = Keypair.generate();
    await airdrop(app.connection, new PublicKey(supported.feePayer), 1_000_000_000);
    await airdrop(app.connection, payer.publicKey, 2_000_000_000);
    const blockhash = (await app.connection.getLatestBlockhash('confirmed')).blockhash;

    const unpaid = await fetch(`${base}/resource`);
    const challenge = JSON.parse(await unpaid.text());
    const payment = pay.buildPayment({
      challenge,
      transaction: clientTransfer({
        facilitator: supported.feePayer,
        payer,
        blockhash,
        destinations: [{ to: challenge.payTo, lamports: challenge.amount }],
      }),
    });
    const header = { 'X-PAYMENT': pay.encodePaymentHeader(payment) };
    const payToBefore = await balance(app.connection, challenge.payTo);
    const resourceCalls = [
      fetch(`${base}/resource`, { headers: header }),
      fetch(`${base}/resource`, { headers: header }),
    ];
    const resourceResponses = await Promise.all(resourceCalls);
    const resourceTexts = await Promise.all(resourceResponses.map(res => res.text()));
    const resourceStatuses = resourceResponses.map(res => res.status).sort((a, b) => a - b);
    assert.deepEqual(resourceStatuses, [200, 402]);
    assert.equal(resourceTexts.filter(text => text === pay.PROTECTED_RESOURCE).length, 1);
    assert.equal(resourceTexts.filter(text => text.includes(pay.PROTECTED_RESOURCE)).length, 1);
    assert.equal(await balance(app.connection, challenge.payTo) - payToBefore, Number(challenge.amount));
    console.log('same-tick resource releases once');

    const mpp = JSON.parse(await (await fetch(`${base}/resource?scheme=mpp`)).text());
    const mppPayment = pay.buildPayment({
      challenge: mpp,
      transaction: clientTransfer({
        facilitator: supported.feePayer,
        payer,
        blockhash: (await app.connection.getLatestBlockhash('confirmed')).blockhash,
        destinations: mpp.recipients.map(row => ({ to: row.address, lamports: row.amount })),
      }),
    });
    const before = {};
    for (const row of mpp.recipients) before[row.address] = await balance(app.connection, row.address);
    const payload = settleBody(mppPayment, mpp);
    const settleCalls = [
      fetch(`${base}/settle`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: payload }),
      fetch(`${base}/settle`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: payload }),
    ];
    const settleResponses = await Promise.all(settleCalls);
    const settleBodies = await Promise.all(settleResponses.map(res => res.json()));
    const settleStatuses = settleResponses.map(res => res.status).sort((a, b) => a - b);
    assert.deepEqual(settleStatuses, [200, 402]);
    assert.equal(settleBodies.filter(body => body.success === true).length, 1);
    assert.equal(settleBodies.filter(body => body.success === false).length, 1);
    assert.equal(settleBodies.some(body => JSON.stringify(body).includes(pay.PROTECTED_RESOURCE)), false);
    for (const row of mpp.recipients) {
      assert.equal(await balance(app.connection, row.address) - before[row.address], Number(row.amount));
    }
    console.log('same-tick settle succeeds once');
  } finally {
    await new Promise(resolve => app.server.close(resolve));
  }
});

test('an unlanded submit releases the nonce so the same proof can settle', { timeout: 120000 }, async () => {
  const health = await fetch(RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getHealth' }),
  });
  assert.equal((await health.json()).result, 'ok');

  const app = createPaymentsServer({ rpc: RPC });
  const base = await listen(app);
  try {
    const supported = await fetch(`${base}/supported`).then(r => r.json());
    const payer = Keypair.generate();
    await airdrop(app.connection, new PublicKey(supported.feePayer), 1_000_000_000);
    const challenge = JSON.parse(await (await fetch(`${base}/resource`)).text());
    const payment = pay.buildPayment({
      challenge,
      transaction: clientTransfer({
        facilitator: supported.feePayer,
        payer,
        blockhash: (await app.connection.getLatestBlockhash('confirmed')).blockhash,
        destinations: [{ to: challenge.payTo, lamports: challenge.amount }],
      }),
    });
    const payload = settleBody(payment, challenge);
    const missed = await fetch(`${base}/settle`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: payload,
    });
    const missedBody = await missed.json();
    assert.notEqual(missed.status, 200);
    assert.notEqual(missedBody.success, true);
    assert.equal(JSON.stringify(missedBody).includes(pay.PROTECTED_RESOURCE), false);

    await airdrop(app.connection, payer.publicKey, 2_000_000_000);
    const payToBefore = await balance(app.connection, challenge.payTo);
    const settled = await fetch(`${base}/settle`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: payload,
    });
    const settledBody = await settled.json();
    assert.equal(settled.status, 200, JSON.stringify(settledBody));
    assert.equal(settledBody.success, true);
    assert.equal(await balance(app.connection, challenge.payTo) - payToBefore, Number(challenge.amount));
    console.log('unlanded submit rolls the nonce back');
  } finally {
    await new Promise(resolve => app.server.close(resolve));
  }
});
