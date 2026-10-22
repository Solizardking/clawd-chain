const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const path = require('path');
const vm = require('vm');
const fee = require('../lib/priority-fee');
const quota = require('../faucet/quota');
const { shieldLimits } = require('../lib/shield-limits');
const {
  WALLET, IP_A, IP_B, FEE_LEVELS,
  solvePow, failPow, eachCall, countMethod, freePort,
  startFake, startNode, primaryRespond, req, runPrimaryChecks,
} = require('../scripts/service-check');
const { PUBLIC, browserSandbox, runPage } = require('../scripts/browser-scripts');

const LABELS = [
  ['CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d', 'Metaplex'],
  ['CMACYFENjoBMHzapRXyo1JZkVS6EtaDDzkjMrmQLvr4J', 'Candy Machine'],
  ['CMAGAKJ67e9hRZgfC5SFTbZH8MgEmtqazKXjmkaJjWTJ', 'Candy Guard'],
  ['Bf3jjD5Pojx5mHZVwJCWg7wC1oPg2hsn7ufsWaKoHv9E', 'Dark'],
  ['JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4', 'Jupiter'],
  ['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5v', 'Token'],
  ['11111111111111111111111111111111', 'System'],
  ['Vote111111111111111111111111111111111111111', 'Vote'],
  ['MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr', 'Memo'],
  ['2AMyS5oLqvh2j4We5EUe9cHryd2vrCuVSdZtsZrP2PVH', 'Clawd Shield'],
];

function loadChain() {
  const ctx = browserSandbox();
  vm.runInContext(
    fs.readFileSync(path.join(PUBLIC, 'chain.js'), 'utf8'),
    ctx.sandbox,
    { filename: 'chain.js' },
  );
  return ctx.sandbox.ClawdChain;
}

function wallet(digit) {
  return String(digit).repeat(32);
}

async function postRpc(base, body, headers) {
  return req(base + '/', { method: 'POST', headers, body });
}

test('primary gateway, faucet, and explorer checks', { timeout: 30000 }, async () => {
  const summary = await runPrimaryChecks();
  assert.equal(summary.priorityFeeEstimate, 5);
  assert.deepEqual(summary.priorityFeeLevels, FEE_LEVELS);
  assert.equal(summary.blockedStatus, 403);
  assert.equal(summary.blockedMethod, 'getProgramAccounts');
  assert.equal(summary.airdropAmount, 5);
  assert.equal(summary.airdropSignature, 'airdropSigPrimary');
  assert.equal(summary.airdropLamports, 5000000000);
  assert.equal(summary.walletRemaining, 0);
  assert.equal(summary.ipRemaining, 5);
  assert.equal(summary.otherWalletRemaining, 0);
  assert.equal(summary.otherIpRemaining, 10);
  assert.equal(summary.tokenMint, 'MintZ');
  assert.equal(summary.tokenAmount, '42');
  assert.equal(summary.ratePerIp, 40);
  console.log('PASS primary ' + JSON.stringify(summary));
});

test('reducePriorityFees percentiles come from the shipped reducer', () => {
  const reduced = fee.reducePriorityFees([10, 1, 9, 2, 8, 3, 7, 4, 6, 5]);
  assert.equal(reduced.priorityFeeEstimate, 5);
  assert.deepEqual(reduced.priorityFeeLevels, { min: 1, low: 3, medium: 5, high: 7, veryHigh: 9, unsafeMax: 10 });
  const same = fee.reducePriorityFees([5, 1, 8, 3, 9, 2, 7, 4, 6, 10]);
  assert.deepEqual(same.priorityFeeLevels, { min: 1, low: 3, medium: 5, high: 7, veryHigh: 9, unsafeMax: 10 });
  const small = fee.reducePriorityFees([100, 20, 3]);
  assert.equal(small.priorityFeeEstimate, 20);
  assert.deepEqual(small.priorityFeeLevels, { min: 3, low: 3, medium: 20, high: 20, veryHigh: 20, unsafeMax: 100 });
  const empty = fee.reducePriorityFees([]);
  assert.equal(empty.priorityFeeEstimate, 0);
  assert.deepEqual(empty.priorityFeeLevels, { min: 0, low: 0, medium: 0, high: 0, veryHigh: 0, unsafeMax: 0 });
  const single = fee.reducePriorityFees([7]);
  assert.deepEqual(single.priorityFeeLevels, { min: 7, low: 7, medium: 7, high: 7, veryHigh: 7, unsafeMax: 7 });
  const hidden = fee.priorityFeeResult([100, 20, 3], false);
  assert.equal(hidden.priorityFeeEstimate, 20);
  assert.equal(Object.hasOwn(hidden, 'priorityFeeLevels'), false);
  const shown = fee.priorityFeeResult(fee.extractPrioritizationFees([
    { slot: 1, prioritizationFee: 100 },
    { slot: 2, prioritizationFee: 20 },
    { slot: 3, prioritizationFee: 3 },
  ]), true);
  assert.equal(shown.priorityFeeEstimate, 20);
  assert.equal(shown.priorityFeeLevels.min, 3);
  assert.equal(shown.priorityFeeLevels.unsafeMax, 100);
  console.log('PASS fee estimate 5 levels 1,3,5,7,9,10');
});

test('remainingClawd is the shipped quota', () => {
  const now = 5_000_000;
  const fresh = quota.remainingClawd({ walletEvents: [], ipEvents: [], now, amount: 5, ipCap: 10 });
  assert.deepEqual(fresh, { walletRemaining: 5, ipRemaining: 10 });
  const used = quota.remainingClawd({
    walletEvents: [{ t: now - 1000, a: 5 }],
    ipEvents: [{ t: now - 1000, a: 5 }],
    now,
    amount: 5,
    ipCap: 10,
  });
  assert.deepEqual(used, { walletRemaining: 0, ipRemaining: 5 });
  const stale = quota.remainingClawd({
    walletEvents: [{ t: now - quota.DAY - 1, a: 5 }],
    ipEvents: [{ t: now - quota.DAY - 1, a: 9 }],
    now,
    amount: 5,
    ipCap: 10,
  });
  assert.deepEqual(stale, { walletRemaining: 5, ipRemaining: 10 });
  console.log('PASS quota walletRemaining 0 ipRemaining 5');
});

test('gateway fee edge cases against a fake validator', { timeout: 30000 }, async () => {
  const fake = await startFake(primaryRespond);
  const gateway = await startNode('proxy.js', {
    PORT: String(await freePort()),
    UPSTREAM_HTTP: fake.url,
    FAUCET_KEY: 'faucet-key',
    RPC_RATE: '40',
  });
  try {
    const objectParams = await postRpc(gateway.base, {
      jsonrpc: '2.0',
      id: 0,
      method: 'getPriorityFeeEstimate',
      params: { accountKeys: ['OnlyKey'] },
    });
    assert.equal(objectParams.status, 200);
    assert.equal(objectParams.json.id, 0);
    assert.equal(objectParams.json.result.priorityFeeEstimate, 5);
    assert.equal(Object.hasOwn(objectParams.json.result, 'priorityFeeLevels'), false);
    assert.deepEqual(eachCall(fake.seen).filter(call => call.method === 'getRecentPrioritizationFees').at(-1).params, [['OnlyKey']]);

    const missingKeys = await postRpc(gateway.base, {
      jsonrpc: '2.0',
      id: 'no-keys',
      method: 'getPriorityFeeEstimate',
      params: [{ options: { includeAllPriorityFeeLevels: true, lookbackSlots: 4 } }],
    });
    assert.equal(missingKeys.json.result.priorityFeeEstimate, 5);
    assert.deepEqual(missingKeys.json.result.priorityFeeLevels, FEE_LEVELS);
    const noKeysCall = eachCall(fake.seen).filter(call => call.method === 'getRecentPrioritizationFees').at(-1);
    assert.deepEqual(noKeysCall.params, []);
    assert.equal(JSON.stringify(noKeysCall).includes('lookbackSlots'), false);

    const mixed = await postRpc(gateway.base, [
      { jsonrpc: '2.0', id: 'slot', method: 'getSlot', params: [] },
      { jsonrpc: '2.0', id: 'fee', method: 'getPriorityFeeEstimate', params: [{ accountKeys: ['MixKey'] }] },
    ]);
    assert.equal(mixed.status, 200);
    assert.equal(mixed.json[0].result, 12345);
    assert.equal(mixed.json[1].id, 'fee');
    assert.equal(mixed.json[1].result.priorityFeeEstimate, 5);
    assert.deepEqual(eachCall(fake.seen).filter(call => call.method === 'getRecentPrioritizationFees').at(-1).params, [['MixKey']]);

    fake.setHandler(body => ({ jsonrpc: '2.0', id: body.id, result: [] }));
    const empty = await postRpc(gateway.base, {
      jsonrpc: '2.0',
      id: 'empty',
      method: 'getPriorityFeeEstimate',
      params: [{ options: { includeAllPriorityFeeLevels: true } }],
    });
    assert.equal(empty.status, 200);
    assert.equal(empty.json.result.priorityFeeEstimate, 0);
    assert.deepEqual(empty.json.result.priorityFeeLevels, { min: 0, low: 0, medium: 0, high: 0, veryHigh: 0, unsafeMax: 0 });

    fake.setHandler(body => ({ jsonrpc: '2.0', id: body.id, result: [100, 20, 3] }));
    const small = await postRpc(gateway.base, {
      jsonrpc: '2.0',
      id: 'small',
      method: 'getPriorityFeeEstimate',
      params: [{ options: { includeAllPriorityFeeLevels: true } }],
    });
    assert.equal(small.json.result.priorityFeeEstimate, 20);
    assert.deepEqual(small.json.result.priorityFeeLevels, { min: 3, low: 3, medium: 20, high: 20, veryHigh: 20, unsafeMax: 100 });

    fake.setHandler(body => ({ jsonrpc: '2.0', id: body.id, error: { message: 'fee oracle down' } }));
    const down = await postRpc(gateway.base, {
      jsonrpc: '2.0',
      id: 'down',
      method: 'getPriorityFeeEstimate',
      params: [{}],
    });
    assert.equal(down.status, 200);
    assert.equal(down.json.id, 'down');
    assert.equal(Object.hasOwn(down.json, 'result'), false);
    assert.match(down.json.error.message, /fee oracle down/);
    assert.equal(countMethod(fake.seen, 'getPriorityFeeEstimate'), 0);
    console.log('PASS fee edges empty 0 small 20 upstream error');
  } finally {
    await gateway.close();
    await fake.close();
  }
});

test('gateway shield limits stay local', { timeout: 20000 }, async () => {
  const fake = await startFake(primaryRespond);
  const gateway = await startNode('proxy.js', {
    PORT: String(await freePort()),
    UPSTREAM_HTTP: fake.url,
    FAUCET_KEY: 'faucet-key',
    RPC_RATE: '40',
  });
  try {
    const status = await req(gateway.base + '/status');
    assert.equal(status.json.servedMethods.includes('getPriorityFeeEstimate'), true);
    assert.equal(status.json.servedMethods.includes('getShieldLimits'), true);

    const before = fake.seen.length;
    const limits = await postRpc(gateway.base, {
      jsonrpc: '2.0',
      id: 'shield',
      method: 'getShieldLimits',
      params: [],
    });
    assert.equal(limits.status, 200);
    assert.equal(limits.json.id, 'shield');
    assert.equal(limits.json.result.maxDeposit, '100000000000');
    assert.equal(limits.json.result.maxTvl, '10000000000000');
    assert.equal(limits.json.result.remainingTvl, '10000000000000');
    assert.equal(limits.json.result.label, 'Clawd Shield');
    assert.equal(limits.json.result.programId, '2AMyS5oLqvh2j4We5EUe9cHryd2vrCuVSdZtsZrP2PVH');
    assert.equal(limits.json.result.vaultLamports, null);
    assert.deepEqual(limits.json.result, shieldLimits());
    assert.equal(fake.seen.length, before);

    const withVault = await postRpc(gateway.base, {
      jsonrpc: '2.0',
      id: 'vault',
      method: 'getShieldLimits',
      params: { vaultLamports: '1000000000000' },
    });
    assert.equal(withVault.json.result.remainingTvl, '9000000000000');
    assert.equal(withVault.json.result.vaultLamports, '1000000000000');
    assert.deepEqual(withVault.json.result, shieldLimits({ vaultLamports: '1000000000000' }));
    assert.equal(fake.seen.length, before);

    const full = await postRpc(gateway.base, {
      jsonrpc: '2.0',
      id: 'full',
      method: 'getShieldLimits',
      params: [{ vaultLamports: '10000000000001' }],
    });
    assert.equal(full.json.result.remainingTvl, '0');
    assert.equal(fake.seen.length, before);

    const bad = await postRpc(gateway.base, {
      jsonrpc: '2.0',
      id: 'bad-vault',
      method: 'getShieldLimits',
      params: [{ vaultLamports: 'nope' }],
    });
    assert.equal(bad.status, 200);
    assert.equal(bad.json.id, 'bad-vault');
    assert.equal(Object.hasOwn(bad.json, 'result'), false);
    assert.match(bad.json.error.message, /vaultLamports/);
    assert.equal(fake.seen.length, before);

    const mixed = await postRpc(gateway.base, [
      { jsonrpc: '2.0', id: 'slot', method: 'getSlot', params: [] },
      { jsonrpc: '2.0', id: 'shield-2', method: 'getShieldLimits', params: [{}] },
      { jsonrpc: '2.0', id: 'fee', method: 'getPriorityFeeEstimate', params: [{ accountKeys: ['MixKey'], options: { includeAllPriorityFeeLevels: true } }] },
    ]);
    assert.equal(mixed.status, 200);
    assert.equal(mixed.json[0].result, 12345);
    assert.equal(mixed.json[1].id, 'shield-2');
    assert.deepEqual(mixed.json[1].result, shieldLimits());
    assert.equal(mixed.json[2].result.priorityFeeEstimate, 5);
    const methods = eachCall(fake.seen).map(call => call.method);
    assert.equal(methods.includes('getShieldLimits'), false);
    assert.equal(methods.includes('getSlot'), true);
    assert.equal(methods.includes('getRecentPrioritizationFees'), true);
    console.log('PASS shield limits remaining 9000000000000 local');
  } finally {
    await gateway.close();
    await fake.close();
  }
});

test('closed upstream is a JSON-RPC error', { timeout: 20000 }, async () => {
  const gateway = await startNode('proxy.js', {
    PORT: String(await freePort()),
    UPSTREAM_HTTP: 'http://127.0.0.1:1',
    FAUCET_KEY: 'faucet-key',
  });
  try {
    const closed = await postRpc(gateway.base, {
      jsonrpc: '2.0',
      id: 7,
      method: 'getPriorityFeeEstimate',
      params: [{}],
    });
    assert.equal(closed.status, 200);
    assert.equal(closed.json.id, 7);
    assert.equal(Object.hasOwn(closed.json, 'result'), false);
    assert.ok(closed.json.error && closed.json.error.message);
    console.log('PASS closed upstream JSON-RPC error');
  } finally {
    await gateway.close();
  }
});

test('blocklist, batch cap, rate limit, and faucet-key bypass', { timeout: 30000 }, async () => {
  const fake = await startFake(primaryRespond);
  const gateway = await startNode('proxy.js', {
    PORT: String(await freePort()),
    UPSTREAM_HTTP: fake.url,
    FAUCET_KEY: 'faucet-key',
    RPC_RATE: '2',
  });
  try {
    const ip = { 'x-forwarded-for': '198.51.100.77' };
    const batch = Array.from({ length: 11 }, (_unused, i) => ({ jsonrpc: '2.0', id: i, method: 'getSlot', params: [] }));
    const tooBig = await postRpc(gateway.base, batch, ip);
    assert.equal(tooBig.status, 400);
    assert.match(tooBig.json.error.message, /batch max 10/);
    assert.equal(countMethod(fake.seen, 'getSlot'), 0);

    const first = await postRpc(gateway.base, { jsonrpc: '2.0', id: 1, method: 'getSlot', params: [] }, ip);
    const second = await postRpc(gateway.base, { jsonrpc: '2.0', id: 2, method: 'getSlot', params: [] }, ip);
    assert.equal(first.status, 200);
    assert.equal(first.json.result, 12345);
    assert.equal(second.status, 200);
    const third = await postRpc(gateway.base, { jsonrpc: '2.0', id: 3, method: 'getSlot', params: [] }, ip);
    assert.equal(third.status, 429);
    assert.equal(countMethod(fake.seen, 'getSlot'), 2);

    const bypass = await postRpc(gateway.base, { jsonrpc: '2.0', id: 4, method: 'getSlot', params: [] }, {
      ...ip,
      'x-faucet-key': 'faucet-key',
    });
    assert.equal(bypass.status, 200);
    assert.equal(countMethod(fake.seen, 'getSlot'), 3);
    const stillLimited = await postRpc(gateway.base, { jsonrpc: '2.0', id: 5, method: 'getSlot', params: [] }, ip);
    assert.equal(stillLimited.status, 429);
    assert.equal(countMethod(fake.seen, 'getSlot'), 3);

    const keyedBatch = await postRpc(gateway.base, batch, { 'x-faucet-key': 'faucet-key', 'x-forwarded-for': '198.51.100.88' });
    assert.equal(keyedBatch.status, 200);
    assert.equal(countMethod(fake.seen, 'getSlot'), 14);

    for (const method of ['getProgramAccounts', 'getLargestAccounts', 'requestAirdrop']) {
      const before = countMethod(fake.seen, method);
      const pub = await postRpc(gateway.base, { jsonrpc: '2.0', id: method, method, params: [] }, { 'x-forwarded-for': '203.0.113.10' });
      assert.equal(pub.status, 403, method);
      assert.match(pub.json.error.message, new RegExp(method));
      assert.equal(countMethod(fake.seen, method), before);
      const priv = await postRpc(gateway.base, { jsonrpc: '2.0', id: method, method, params: [] }, {
        'x-forwarded-for': '203.0.113.10',
        'x-faucet-key': 'faucet-key',
      });
      assert.equal(priv.status, 200, priv.text);
      assert.equal(countMethod(fake.seen, method), before + 1);
    }
    console.log('PASS blocklist batch 10 rate 2 faucet-key bypass');
  } finally {
    await gateway.close();
    await fake.close();
  }
});

test('faucet rejects do not airdrop and caps leave the challenge usable', { timeout: 30000 }, async () => {
  const fake = await startFake(body => {
    const call = Array.isArray(body) ? body[0] : body;
    if (call && call.method === 'requestAirdrop') return { jsonrpc: '2.0', id: call.id, result: 'sigReject' };
    return { jsonrpc: '2.0', id: call && call.id, result: { ok: true } };
  });
  const faucet = await startNode('faucet/server.js', {
    PORT: String(await freePort()),
    VALIDATOR_RPC: fake.url,
    FAUCET_KEY: 'faucet-key',
    POW_SECRET: 'test-secret',
    POW_BITS: '8',
    AIRDROP_SOL: '5',
    IP_CAP_SOL: '10',
  }, '/health');
  const short = await startNode('faucet/server.js', {
    PORT: String(await freePort()),
    VALIDATOR_RPC: fake.url,
    FAUCET_KEY: 'faucet-key',
    POW_SECRET: 'test-secret',
    POW_BITS: '8',
    AIRDROP_SOL: '5',
    IP_CAP_SOL: '10',
    CHALLENGE_TTL_MS: '30',
  }, '/health');
  try {
    async function airdrop(base, address, xff, known) {
      const challengeRes = known || await req(base + '/challenge');
      const challenge = known ? known.challenge : challengeRes.json.challenge;
      const bits = known ? known.bits : challengeRes.json.bits;
      const nonce = known && Object.prototype.hasOwnProperty.call(known, 'nonce') ? known.nonce : solvePow(challenge, bits);
      const response = await req(base + '/airdrop', {
        method: 'POST',
        headers: { 'x-forwarded-for': xff },
        body: { address, challenge, nonce },
      });
      return { response, challenge, bits, nonce };
    }

    const badAddress = await req(faucet.base + '/airdrop', {
      method: 'POST',
      headers: { 'x-forwarded-for': IP_A },
      body: { address: 'not-a-wallet', challenge: '1.2.nope', nonce: 0 },
    });
    assert.equal(badAddress.status, 400);
    assert.match(badAddress.json.error, /invalid address/);

    const badChallenge = await req(faucet.base + '/airdrop', {
      method: 'POST',
      headers: { 'x-forwarded-for': IP_A },
      body: { address: wallet(1), challenge: '1.2.nope', nonce: 0 },
    });
    assert.equal(badChallenge.status, 400);
    assert.match(badChallenge.json.error, /challenge/);

    const issued = await req(faucet.base + '/challenge');
    const weak = failPow(issued.json.challenge, issued.json.bits);
    const weakRes = await req(faucet.base + '/airdrop', {
      method: 'POST',
      headers: { 'x-forwarded-for': IP_A },
      body: { address: wallet(1), challenge: issued.json.challenge, nonce: weak },
    });
    assert.equal(weakRes.status, 400);
    assert.match(weakRes.json.error, /proof of work/);
    assert.equal(countMethod(fake.seen, 'requestAirdrop'), 0);

    const first = await airdrop(faucet.base, wallet(1), IP_A);
    assert.equal(first.response.status, 200, first.response.text);
    assert.equal(first.response.json.amount, 5);
    assert.equal(first.response.json.signature, 'sigReject');
    assert.deepEqual(eachCall(fake.seen).find(call => call.method === 'requestAirdrop').params, [wallet(1), 5000000000]);

    const reused = await req(faucet.base + '/airdrop', {
      method: 'POST',
      headers: { 'x-forwarded-for': IP_A },
      body: { address: wallet(2), challenge: first.challenge, nonce: first.nonce },
    });
    assert.equal(reused.status, 400);
    assert.equal(countMethod(fake.seen, 'requestAirdrop'), 1);

    const capped = await airdrop(faucet.base, wallet(1), IP_A);
    assert.equal(capped.response.status, 429);
    assert.match(capped.response.json.error, /wallet limit/);
    assert.equal(countMethod(fake.seen, 'requestAirdrop'), 1);
    const passedOn = await req(faucet.base + '/airdrop', {
      method: 'POST',
      headers: { 'x-forwarded-for': IP_A },
      body: { address: wallet(2), challenge: capped.challenge, nonce: capped.nonce },
    });
    assert.equal(passedOn.status, 200, passedOn.text);
    assert.equal(countMethod(fake.seen, 'requestAirdrop'), 2);

    const ipBlocked = await airdrop(faucet.base, wallet(3), IP_A);
    assert.equal(ipBlocked.response.status, 429);
    assert.match(ipBlocked.response.json.error, /IP limit/);
    assert.equal(countMethod(fake.seen, 'requestAirdrop'), 2);
    const otherIp = await req(faucet.base + '/airdrop', {
      method: 'POST',
      headers: { 'x-forwarded-for': IP_B },
      body: { address: wallet(3), challenge: ipBlocked.challenge, nonce: ipBlocked.nonce },
    });
    assert.equal(otherIp.status, 200, otherIp.text);
    assert.equal(countMethod(fake.seen, 'requestAirdrop'), 3);

    const quotaSame = await req(faucet.base + '/quota?address=' + wallet(1), { headers: { 'x-forwarded-for': IP_A } });
    const drops = countMethod(fake.seen, 'requestAirdrop');
    assert.equal(quotaSame.json.walletRemaining, 0);
    assert.equal(quotaSame.json.ipRemaining, 0);
    assert.equal(countMethod(fake.seen, 'requestAirdrop'), drops);

    const expiring = await req(short.base + '/challenge');
    const expNonce = solvePow(expiring.json.challenge, expiring.json.bits);
    await new Promise(resolve => setTimeout(resolve, 80));
    const expired = await req(short.base + '/airdrop', {
      method: 'POST',
      headers: { 'x-forwarded-for': '198.51.100.50' },
      body: { address: wallet(4), challenge: expiring.json.challenge, nonce: expNonce },
    });
    assert.equal(expired.status, 400);
    assert.match(expired.json.error, /challenge/);
    assert.equal(countMethod(fake.seen, 'requestAirdrop'), 3);
    console.log('PASS faucet rejects leave requestAirdrop at 3');
  } finally {
    await faucet.close();
    await short.close();
    await fake.close();
  }
});

function postClose(url, body, headers) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const target = new URL(url);
    const request = http.request({
      hostname: target.hostname,
      port: target.port,
      path: target.pathname,
      method: 'POST',
      agent: false,
      headers: {
        ...(headers || {}),
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
        connection: 'close',
      },
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let parsed = null;
        try { parsed = JSON.parse(text); } catch { parsed = null; }
        resolve({ status: response.statusCode, text, json: parsed });
      });
    });
    request.on('error', reject);
    request.end(payload);
  });
}

function startGateFake() {
  const seen = [];
  let openGate = () => {};
  const gate = new Promise(resolve => { openGate = resolve; });
  let held = false;
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', async () => {
      let body = null;
      const raw = Buffer.concat(chunks).toString('utf8');
      try { body = raw ? JSON.parse(raw) : null; } catch { body = { raw }; }
      seen.push(body);
      if (body && body.method === 'requestAirdrop' && !held) {
        held = true;
        await gate;
      }
      if (res.writableEnded) return;
      const id = body && Object.prototype.hasOwnProperty.call(body, 'id') ? body.id : null;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id, result: 'sigOverlap' }));
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}`,
        seen,
        release: openGate,
        close() {
          openGate();
          return new Promise(done => {
            if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
            server.close(() => done());
          });
        },
      });
    });
  });
}

async function solvedPosts(base, specs) {
  const posts = [];
  for (const spec of specs) {
    const issued = await req(base + '/challenge');
    posts.push({
      headers: { 'x-forwarded-for': spec.ip },
      body: {
        address: spec.address,
        challenge: issued.json.challenge,
        nonce: solvePow(issued.json.challenge, issued.json.bits),
      },
    });
  }
  return posts;
}

async function overlappingAirdrops(cap, specs, limitPattern) {
  const fake = await startGateFake();
  const faucet = await startNode('faucet/server.js', {
    PORT: String(await freePort()),
    VALIDATOR_RPC: fake.url,
    FAUCET_KEY: 'faucet-key',
    POW_SECRET: 'test-secret',
    POW_BITS: '8',
    AIRDROP_SOL: '5',
    IP_CAP_SOL: cap,
  }, '/health');
  try {
    const posts = await solvedPosts(faucet.base, specs);
    let early = null;
    const pending = posts.map(post => postClose(faucet.base + '/airdrop', post.body, post.headers).then(result => {
      if (!early) early = result;
      return result;
    }));
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (countMethod(fake.seen, 'requestAirdrop') > 1) break;
      if (countMethod(fake.seen, 'requestAirdrop') === 1 && early && early.status === 429) break;
      await new Promise(resolve => setTimeout(resolve, 15));
    }
    assert.equal(countMethod(fake.seen, 'requestAirdrop'), 1);
    assert.equal(early && early.status, 429);
    assert.match(early.json.error, limitPattern);
    const heldFirst = await req(faucet.base + '/quota?address=' + specs[0].address, {
      headers: { 'x-forwarded-for': specs[0].ip },
    });
    const heldSecond = await req(faucet.base + '/quota?address=' + specs[1].address, {
      headers: { 'x-forwarded-for': specs[1].ip },
    });
    assert.equal(heldFirst.json.ipRemaining, Number(cap) - 5);
    assert.equal(heldSecond.json.ipRemaining, Number(cap) - 5);
    const reservedWallets = [heldFirst.json.walletRemaining, heldSecond.json.walletRemaining].sort((a, b) => a - b);
    assert.deepEqual(reservedWallets, specs[0].address === specs[1].address ? [0, 0] : [0, 5]);
    assert.equal(countMethod(fake.seen, 'requestAirdrop'), 1);
    fake.release();
    const results = await Promise.all(pending);
    assert.deepEqual(results.map(result => result.status).sort(), [200, 429]);
    const ok = results.find(result => result.status === 200);
    assert.equal(ok.json.amount, 5);
    assert.equal(ok.json.signature, 'sigOverlap');
    assert.match(results.find(result => result.status === 429).json.error, limitPattern);
    assert.equal(countMethod(fake.seen, 'requestAirdrop'), 1);
    const airdrop = eachCall(fake.seen).find(call => call.method === 'requestAirdrop');
    assert.equal(airdrop.params[1], 5000000000);
    assert.equal(posts.some(post => post.body.address === airdrop.params[0]), true);
    const deniedPost = posts[results.findIndex(result => result.status === 429)];
    return { faucet, fake, deniedPost, airdrop };
  } catch (err) {
    await faucet.close();
    await fake.close();
    throw err;
  }
}

test('overlapping solved airdrops reserve wallet and IP allowance', { timeout: 30000 }, async () => {
  const walletRace = await overlappingAirdrops('10', [
    { address: wallet(1), ip: IP_A },
    { address: wallet(1), ip: IP_A },
  ], /wallet limit/);
  try {
    const after = await req(walletRace.faucet.base + '/quota?address=' + wallet(1), {
      headers: { 'x-forwarded-for': IP_A },
    });
    assert.equal(after.json.walletRemaining, 0);
    assert.equal(after.json.ipRemaining, 5);
    assert.deepEqual(walletRace.airdrop.params, [wallet(1), 5000000000]);
    const passedOn = await req(walletRace.faucet.base + '/airdrop', {
      method: 'POST',
      headers: { 'x-forwarded-for': IP_B },
      body: {
        address: wallet(2),
        challenge: walletRace.deniedPost.body.challenge,
        nonce: walletRace.deniedPost.body.nonce,
      },
    });
    assert.equal(passedOn.status, 200, passedOn.text);
    assert.equal(countMethod(walletRace.fake.seen, 'requestAirdrop'), 2);
    console.log('PASS overlapping wallet airdrop stays at 1');
  } finally {
    await walletRace.faucet.close();
    await walletRace.fake.close();
  }

  const ipRace = await overlappingAirdrops('5', [
    { address: wallet(3), ip: IP_A },
    { address: wallet(4), ip: IP_A },
  ], /IP limit/);
  try {
    const winner = ipRace.airdrop.params[0];
    const winnerQuota = await req(ipRace.faucet.base + '/quota?address=' + winner, {
      headers: { 'x-forwarded-for': IP_A },
    });
    assert.equal(winnerQuota.json.walletRemaining, 0);
    assert.equal(winnerQuota.json.ipRemaining, 0);
    const otherIp = await req(ipRace.faucet.base + '/airdrop', {
      method: 'POST',
      headers: { 'x-forwarded-for': IP_B },
      body: {
        address: ipRace.deniedPost.body.address,
        challenge: ipRace.deniedPost.body.challenge,
        nonce: ipRace.deniedPost.body.nonce,
      },
    });
    assert.equal(otherIp.status, 200, otherIp.text);
    assert.equal(countMethod(ipRace.fake.seen, 'requestAirdrop'), 2);
    console.log('PASS overlapping IP airdrop stays at 1');
  } finally {
    await ipRace.faucet.close();
    await ipRace.fake.close();
  }
});

test('failed requestAirdrop rolls the reserved allowance back', { timeout: 20000 }, async () => {
  let airdrops = 0;
  const fake = await startFake(body => {
    const call = Array.isArray(body) ? body[0] : body;
    const id = call && call.id;
    if (call && call.method === 'requestAirdrop') {
      airdrops += 1;
      if (airdrops === 1) return { jsonrpc: '2.0', id, error: { message: 'airdrop failed' } };
      return { jsonrpc: '2.0', id, result: 'sigAfterRollback' };
    }
    return { jsonrpc: '2.0', id, result: null };
  });
  const faucet = await startNode('faucet/server.js', {
    PORT: String(await freePort()),
    VALIDATOR_RPC: fake.url,
    FAUCET_KEY: 'faucet-key',
    POW_SECRET: 'test-secret',
    POW_BITS: '8',
    AIRDROP_SOL: '5',
    IP_CAP_SOL: '10',
  }, '/health');
  try {
    const posts = await solvedPosts(faucet.base, [{ address: wallet(5), ip: IP_A }]);
    const failed = await req(faucet.base + '/airdrop', {
      method: 'POST',
      headers: posts[0].headers,
      body: posts[0].body,
    });
    assert.equal(failed.status, 502);
    assert.match(failed.json.error, /airdrop failed/);
    assert.equal(countMethod(fake.seen, 'requestAirdrop'), 1);
    assert.deepEqual(eachCall(fake.seen).find(call => call.method === 'requestAirdrop').params, [wallet(5), 5000000000]);
    const restored = await req(faucet.base + '/quota?address=' + wallet(5), { headers: { 'x-forwarded-for': IP_A } });
    assert.equal(restored.json.walletRemaining, 5);
    assert.equal(restored.json.ipRemaining, 10);
    assert.equal(countMethod(fake.seen, 'requestAirdrop'), 1);
    const reused = await req(faucet.base + '/airdrop', {
      method: 'POST',
      headers: posts[0].headers,
      body: posts[0].body,
    });
    assert.equal(reused.status, 400);
    assert.match(reused.json.error, /challenge/);
    assert.equal(countMethod(fake.seen, 'requestAirdrop'), 1);
    const again = await solvedPosts(faucet.base, [{ address: wallet(5), ip: IP_A }]);
    const ok = await req(faucet.base + '/airdrop', {
      method: 'POST',
      headers: again[0].headers,
      body: again[0].body,
    });
    assert.equal(ok.status, 200, ok.text);
    assert.equal(ok.json.signature, 'sigAfterRollback');
    assert.equal(ok.json.amount, 5);
    assert.equal(countMethod(fake.seen, 'requestAirdrop'), 2);
    const used = await req(faucet.base + '/quota?address=' + wallet(5), { headers: { 'x-forwarded-for': IP_A } });
    assert.equal(used.json.walletRemaining, 0);
    assert.equal(used.json.ipRemaining, 5);
    console.log('PASS failed airdrop rolls allowance back');
  } finally {
    await faucet.close();
    await fake.close();
  }
});

test('openapi lists getPriorityFeeEstimate and the disabled methods', { timeout: 20000 }, async () => {
  const api = await startNode('api/server.js', { PORT: String(await freePort()) }, '/health');
  try {
    const spec = await req(api.base + '/openapi.json');
    assert.equal(spec.status, 200);
    const methods = spec.json.paths['/rpc'].post.requestBody.content['application/json'].schema.properties.method.enum;
    assert.equal(methods.includes('getPriorityFeeEstimate'), true);
    assert.equal(methods.includes('getProgramAccounts'), false);
    assert.equal(methods.includes('getLargestAccounts'), false);
    assert.equal(methods.includes('requestAirdrop'), false);
    assert.match(spec.json.info.description, /getProgramAccounts/);
    assert.match(spec.json.info.description, /getLargestAccounts/);
    assert.match(spec.json.info.description, /requestAirdrop/);
    assert.match(spec.json.info.description, /disabled/);
    console.log('PASS openapi getPriorityFeeEstimate disabled methods');
  } finally {
    await api.close();
  }
});

test('chain.js token deltas, program labels, and search class', () => {
  const src = fs.readFileSync(path.join(PUBLIC, 'chain.js'), 'utf8');
  assert.doesNotMatch(src, /\brequire\s*\(/);
  assert.doesNotMatch(src, /\bimport\s/);
  assert.doesNotMatch(src, /\bexport\s/);
  const chain = loadChain();
  const rows = chain.tokenDeltas([
    { accountIndex: 1, mint: 'MintA', owner: 'OwnA', uiTokenAmount: { amount: '1000', decimals: 6 } },
    { accountIndex: 2, mint: 'MintB', owner: 'OwnB', uiTokenAmount: { amount: '50', decimals: 9 } },
  ], [
    { accountIndex: 1, mint: 'MintA', owner: 'OwnA', uiTokenAmount: { amount: '400', decimals: 6 } },
    { accountIndex: 3, mint: 'MintC', owner: 'OwnC', uiTokenAmount: { amount: '7', decimals: 0 } },
  ]);
  const host = value => JSON.parse(JSON.stringify(value));
  assert.deepEqual(host(rows.map(row => row.delta)), [-600, -50, 7]);
  assert.deepEqual(host(rows.map(row => row.mint)), ['MintA', 'MintB', 'MintC']);
  assert.deepEqual(host(rows.map(row => row.owner)), ['OwnA', 'OwnB', 'OwnC']);
  assert.deepEqual(host(rows.map(row => row.decimals)), [6, 9, 0]);
  for (const [id, needle] of LABELS) {
    const label = chain.programLabel(id);
    assert.equal(label.includes(needle), true, label);
  }
  assert.equal(chain.programLabel('UnknownProg'), 'UnknownProg');
  assert.equal(chain.programLabel(null), '');
  assert.equal(chain.programLabel(''), '');
  const hostQuery = query => JSON.parse(JSON.stringify(chain.classifyQuery(query)));
  assert.deepEqual(hostQuery(' 55 '), { kind: 'slot', path: '/block/55' });
  const sig = 'S'.repeat(80);
  assert.deepEqual(hostQuery(sig), { kind: 'signature', path: '/tx/' + sig });
  assert.deepEqual(hostQuery('1'.repeat(32)), { kind: 'slot', path: '/block/' + '1'.repeat(32) });
  const addr = 'A' + '1'.repeat(31);
  assert.deepEqual(hostQuery(addr), { kind: 'address', path: '/address/' + addr });
  console.log('PASS deltas -600,-50,7 labels ' + LABELS.length);
});

test('explorer page renders deltas, labels, and search routes', async () => {
  const sig = 'A'.repeat(87);
  const tx = {
    slot: 9,
    blockTime: 1_700_000_000,
    version: 0,
    transaction: {
      signatures: [sig],
      message: {
        accountKeys: [{ pubkey: 'FeePayer111111111111111111111111111111' }],
        instructions: LABELS.map(([programId]) => ({ programId, program: '', data: '' })).concat([
          { programId: 'UnknownProg11111111111111111111111111111' },
        ]),
      },
    },
    meta: {
      err: null,
      fee: 5000,
      preBalances: [1_000_000_000],
      postBalances: [999_995_000],
      computeUnitsConsumed: 1,
      logMessages: [],
      preTokenBalances: [
        { accountIndex: 1, mint: 'MintA', owner: 'OwnA', uiTokenAmount: { amount: '1000', decimals: 6 } },
        { accountIndex: 2, mint: 'MintB', owner: 'OwnB', uiTokenAmount: { amount: '50', decimals: 9 } },
      ],
      postTokenBalances: [
        { accountIndex: 1, mint: 'MintA', owner: 'OwnA', uiTokenAmount: { amount: '400', decimals: 6 } },
        { accountIndex: 3, mint: 'MintC', owner: 'OwnC', uiTokenAmount: { amount: '7', decimals: 0 } },
      ],
    },
  };
  function jsonResult(result) {
    return { ok: true, json: async () => ({ result }) };
  }
  const page = runPage(path.join(PUBLIC, 'explorer.html'), {
    pathname: '/tx/' + sig,
    fetch: async (_url, opts) => {
      const body = opts && opts.body ? JSON.parse(opts.body) : {};
      if (body.method === 'getTransaction') return jsonResult(tx);
      if (body.method === 'getAccountInfo') {
        return jsonResult({
          value: {
            lamports: 1000,
            owner: '11111111111111111111111111111111',
            executable: false,
            data: ['', 'base64'],
            rentEpoch: 0,
          },
        });
      }
      if (body.method === 'getSignaturesForAddress') return jsonResult([]);
      if (body.method === 'getTokenAccountsByOwner') {
        return jsonResult({
          value: [{
            pubkey: 'TokAcc111',
            account: { data: { parsed: { info: { mint: 'MintZ', tokenAmount: { amount: '42', decimals: 6 } } } } },
          }],
        });
      }
      if (body.method === 'getBlock') return jsonResult(null);
      return jsonResult(null);
    },
  });
  assert.equal(page.ordered[0].src, '/chain.js');
  assert.equal(page.ordered.at(-1).src, '/webmcp.js');
  assert.equal(page.ordered.at(-1).defer, true);
  const app = page.document.querySelector('#app');
  async function waitFor(pred) {
    const started = Date.now();
    while (Date.now() - started < 2000) {
      if (pred()) return;
      await new Promise(resolve => setImmediate(resolve));
    }
    throw new Error('page did not render: ' + app.innerHTML.slice(0, 400));
  }
  await waitFor(() => app.innerHTML.includes('-600') && app.innerHTML.includes('Metaplex'));
  for (const needle of ['MintA', 'MintB', 'MintC', '-600', '-50', 'Token Program', 'System Program', 'Vote Program', 'Memo Program', 'Dark Protocol', 'Candy Machine', 'Candy Guard', 'Jupiter', 'Clawd Shield', 'UnknownProg']) {
    assert.equal(app.innerHTML.includes(needle), true, needle);
  }
  assert.match(app.innerHTML, />7<\/td>/);

  const input = page.document.querySelector('#q');
  const form = page.document.querySelector('#sf');
  function submit(value) {
    input.value = value;
    form.onsubmit({ preventDefault() {} });
  }
  submit('55');
  assert.equal(page.location.pathname, '/block/55');
  await waitFor(() => app.innerHTML.includes('not available'));
  const longSig = 'B'.repeat(80);
  submit(longSig);
  assert.equal(page.location.pathname, '/tx/' + longSig);
  await waitFor(() => app.innerHTML.includes('-600'));
  const addr = 'C'.repeat(32);
  submit(addr);
  assert.equal(page.location.pathname, '/address/' + addr);
  await waitFor(() => app.innerHTML.includes('MintZ') && app.innerHTML.includes('42'));
  console.log('PASS explorer page MintZ 42 deltas -600,-50,7');
});

test('faucet page accepts clicks and the shared hasher completes a drip', { timeout: 30000 }, async () => {
  const pow = require('../faucet/pow');
  assert.equal(Buffer.from(pow.sha256('')).toString('hex'), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.equal(Buffer.from(pow.sha256('abc')).toString('hex'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  const faucetPow = fs.readFileSync(path.join(__dirname, '..', 'faucet', 'pow.js'), 'utf8');
  assert.equal(faucetPow, fs.readFileSync(path.join(__dirname, '..', 'extension', 'pow.js'), 'utf8'));
  const fake = await startFake(body => {
    const call = Array.isArray(body) ? body[0] : body;
    if (call && call.method === 'requestAirdrop') return { jsonrpc: '2.0', id: call.id, result: 'sigPow' };
    return { jsonrpc: '2.0', id: call && call.id, result: { ok: true } };
  });
  const faucet = await startNode('faucet/server.js', {
    PORT: String(await freePort()),
    VALIDATOR_RPC: fake.url,
    FAUCET_KEY: 'faucet-key',
    POW_SECRET: 'test-secret',
    POW_BITS: '8',
    AIRDROP_SOL: '5',
    IP_CAP_SOL: '10',
  }, '/health');
  try {
    const page = await req(faucet.base + '/');
    assert.equal(page.status, 200);
    assert.match(page.text, /\.box:before\{[^}]*pointer-events:none/);
    assert.match(page.text, /canvas#bg,canvas#fx\{[^}]*pointer-events:none/);
    assert.match(page.text, /src="\/pow\.js"/);
    assert.match(page.text, /ClawdPow\.solve/);
    const script = await req(faucet.base + '/pow.js');
    assert.equal(script.status, 200);
    assert.equal(script.text, faucetPow);
    const preflight = await req(faucet.base + '/airdrop', { method: 'OPTIONS' });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('access-control-allow-origin'), '*');
    const issued = await req(faucet.base + '/challenge');
    const solved = await pow.solve(issued.json.challenge, issued.json.bits);
    const nodeHash = require('node:crypto').createHash('sha256').update(issued.json.challenge + ':' + solved.nonce).digest();
    assert.equal(Buffer.from(solved.hash).equals(nodeHash), true);
    const drop = await req(faucet.base + '/airdrop', {
      method: 'POST',
      headers: { 'x-forwarded-for': IP_A },
      body: { address: wallet(1), challenge: issued.json.challenge, nonce: solved.nonce },
    });
    assert.equal(drop.status, 200, drop.text);
    assert.equal(drop.json.amount, 5);
    assert.equal(drop.json.signature, 'sigPow');
    const quotaAfter = await req(faucet.base + '/quota?address=' + wallet(1), { headers: { 'x-forwarded-for': IP_A } });
    assert.equal(quotaAfter.json.walletRemaining, 0);
    assert.equal(quotaAfter.json.ipRemaining, 5);
    console.log('PASS faucet hasher drip nonce ' + solved.nonce);
  } finally {
    await faucet.close();
    await fake.close();
  }
});

test('explorer and landing scripts load with no module and no throw', () => {
  const landing = runPage(path.join(PUBLIC, 'index.html'));
  const explorer = runPage(path.join(PUBLIC, 'explorer.html'));
  assert.equal(landing.scripts.some(script => script.type === 'module'), false);
  assert.equal(explorer.scripts.some(script => script.type === 'module'), false);
  assert.equal(explorer.sandbox.ClawdChain.programLabel('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5v').includes('Token'), true);
  assert.equal(landing.html.includes('2AMyS5oLqvh2j4We5EUe9cHryd2vrCuVSdZtsZrP2PVH'), true);
  console.log('PASS browser scripts no throw');
});
