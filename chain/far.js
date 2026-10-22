// Far protocol. Named accounts, scoped keys, and receipts follow the local
// nearcore clone (access keys, action receipts, per-shard congestion).
// Signatures are FIPS 204 ML-DSA-65. Intents settle in CLAWD with no separate
// gas balance. Model work included in a block pays its CLAWD charge to that
// block's producer.
const { Worker } = require('node:worker_threads');
const { canonical, sha256Hex } = require('./codec');
const { signBytes, verifyBytes } = require('./sign');

const CLAWD = 'CLAWD';
const SHARDS = ['shard-0', 'shard-1'];
const WORK_KINDS = ['authentication', 'attestation', 'verification', 'inference'];
const CHARGES = {
  authentication: 5n,
  attestation: 7n,
  verification: 11n,
  inference: 13n,
};
// Hashes per action when a test compares one shard with two. Large enough that
// the parallel run is shorter than the same batch on one shard.
const SPEED_UNITS = 800000;

const WORKER_SOURCE = `
const { createHash } = require('crypto');
const { parentPort, workerData } = require('worker_threads');
let hash = Buffer.alloc(32, 1);
for (let i = 0; i < workerData; i++) hash = createHash('sha256').update(hash).digest();
parentPort.postMessage(hash.length);
`;

function reject(reason) {
  return { ok: false, reason };
}

function asInt(amount) {
  if (typeof amount === 'bigint') return amount;
  if (typeof amount === 'number' && Number.isSafeInteger(amount)) return BigInt(amount);
  if (typeof amount === 'string' && /^-?\d+$/.test(amount)) return BigInt(amount);
  return null;
}

function isAccountId(id) {
  if (typeof id !== 'string' || id.length < 2 || id.length > 64) return false;
  if (/^[0-9a-f]{64}$/.test(id)) return true;
  return /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/.test(id);
}

function readBalance(account, asset) {
  if (!account) return 0n;
  const amount = account.balances[asset];
  return typeof amount === 'bigint' ? amount : 0n;
}

function snapshot(far) {
  const accounts = new Map();
  for (const [id, account] of far.accounts) {
    const balances = Object.create(null);
    for (const asset of Object.keys(account.balances)) balances[asset] = account.balances[asset];
    accounts.set(id, { balances, nonce: new Map(account.nonces), calls: account.calls });
  }
  return { accounts, mined: new Map(far.mined) };
}

function restore(far, snap) {
  for (const [id, saved] of snap.accounts) {
    const account = far.accounts.get(id);
    account.balances = saved.balances;
    account.nonces = saved.nonce;
    account.calls = saved.calls;
  }
  far.mined = snap.mined;
}

function createFar() {
  const shards = Object.create(null);
  for (const id of SHARDS) {
    shards[id] = { fee: 1n, delay: 0n, queued: 0, capacity: 64, collected: 0n };
  }
  return {
    now: 0n,
    height: 0n,
    accounts: new Map(),
    shards,
    intents: new Map(),
    fills: new Map(),
    chunks: new Map(),
    blocks: [],
    mined: new Map(),
  };
}

function setTime(far, now) {
  const value = asInt(now);
  if (value == null || value < 0n) return reject('time');
  far.now = value;
  return { ok: true, now: value };
}

function balance(far, accountId, asset = CLAWD) {
  return readBalance(far.accounts.get(accountId), asset);
}

function mined(far, producer) {
  const amount = far.mined.get(producer);
  return typeof amount === 'bigint' ? amount : 0n;
}

function chargeFor(kind) {
  return Object.prototype.hasOwnProperty.call(CHARGES, kind) ? CHARGES[kind] : null;
}

function quoteShard(far, shard) {
  const row = far.shards[shard];
  if (!row) return reject('shard');
  return {
    ok: true,
    shard,
    fee: row.fee,
    delay: row.delay,
    queued: row.queued,
    capacity: row.capacity,
    collected: row.collected,
  };
}

function setShard(far, shard, { fee, delay, capacity } = {}) {
  const row = far.shards[shard];
  if (!row) return reject('shard');
  if (fee != null) {
    const value = asInt(fee);
    if (value == null || value < 0n) return reject('amount');
    row.fee = value;
  }
  if (delay != null) {
    const value = asInt(delay);
    if (value == null || value < 0n) return reject('amount');
    row.delay = value;
  }
  if (capacity != null) {
    if (!Number.isInteger(capacity) || capacity < 0) return reject('shard');
    row.capacity = capacity;
  }
  return quoteShard(far, shard);
}

function fillQueue(far, shard, count) {
  const row = far.shards[shard];
  if (!row) return reject('shard');
  if (!Number.isInteger(count) || count < 0) return reject('shard');
  const before = quoteShard(far, shard);
  row.queued = Math.min(row.capacity, row.queued + count);
  if (row.queued >= row.capacity) row.delay += 1000n;
  return { ok: true, before, quote: quoteShard(far, shard) };
}

function createAccount(far, { accountId, publicKey, shard, balances = {} } = {}) {
  if (!isAccountId(accountId) || far.accounts.has(accountId)) return reject('account');
  if (!far.shards[shard]) return reject('shard');
  if (typeof publicKey !== 'string' || publicKey.length === 0) return reject('key');
  const stored = Object.create(null);
  for (const asset of Object.keys(balances)) {
    const amount = asInt(balances[asset]);
    if (amount == null || amount < 0n) return reject('amount');
    stored[asset] = amount;
  }
  const nonces = new Map();
  nonces.set(publicKey, 0n);
  far.accounts.set(accountId, {
    accountId,
    shard,
    balances: stored,
    keys: new Map([[publicKey, { kind: 'fullAccess' }]]),
    nonces,
    calls: 0n,
  });
  return { ok: true, accountId, shard };
}

function permissionOf(key) {
  if (!key) return null;
  if (key.kind === 'fullAccess') return key;
  if (key.kind !== 'functionCall') return null;
  if (typeof key.receiverId !== 'string' || !Array.isArray(key.methodNames)) return null;
  return key;
}

function addKey(far, { accountId, signerPublicKey, signerPrivateKey, publicKey, permission, nonce } = {}) {
  const action = { type: 'addKey', publicKey, permission };
  const auth = authenticate(far, { accountId, publicKey: signerPublicKey, privateKey: signerPrivateKey, nonce, action });
  if (!auth.ok) return auth;
  if (auth.key.kind !== 'fullAccess') return reject('scope');
  const next = permissionOf(permission);
  if (!next || typeof publicKey !== 'string' || publicKey.length === 0) return reject('key');
  if (auth.account.keys.has(publicKey)) return reject('key');
  auth.account.keys.set(publicKey, {
    kind: next.kind,
    receiverId: next.receiverId,
    methodNames: next.methodNames ? [...next.methodNames] : [],
  });
  auth.account.nonces.set(publicKey, 0n);
  auth.account.nonces.set(signerPublicKey, auth.nonce);
  return { ok: true, publicKey };
}

function authenticate(far, { accountId, publicKey, privateKey, nonce, action }) {
  const account = far.accounts.get(accountId);
  if (!account) return reject('account');
  const key = account.keys.get(publicKey);
  if (!key) return reject('key');
  const nextNonce = asInt(nonce);
  const current = account.nonces.get(publicKey);
  if (nextNonce == null || current == null || nextNonce <= current) return reject('nonce');
  const body = canonical({
    protocol: 'far',
    accountId,
    nonce: nextNonce.toString(),
    action,
  });
  let signature;
  try {
    signature = signBytes(privateKey, Buffer.from(body, 'utf8'));
  } catch {
    return reject('signature');
  }
  if (!verifyBytes(publicKey, Buffer.from(body, 'utf8'), signature)) return reject('signature');
  return { ok: true, account, key, nonce: nextNonce, body, signature };
}

function functionCall(far, { accountId, publicKey, privateKey, receiverId, method, deposit = 0n, nonce } = {}) {
  const value = asInt(deposit);
  if (value == null || value < 0n) return reject('amount');
  if (typeof method !== 'string' || method.length === 0) return reject('scope');
  const action = { type: 'functionCall', receiverId, method, deposit: value.toString() };
  const auth = authenticate(far, { accountId, publicKey, privateKey, nonce, action });
  if (!auth.ok) return auth;
  const receiver = far.accounts.get(receiverId);
  if (!receiver) return reject('account');
  if (auth.key.kind === 'functionCall') {
    // Mirrors nearcore verifier.verify_function_call_permission: one call,
    // zero deposit, receiver match, method on the list when the list is set.
    if (value !== 0n) return reject('scope');
    if (receiverId !== auth.key.receiverId) return reject('scope');
    if (auth.key.methodNames.length > 0 && !auth.key.methodNames.includes(method)) return reject('scope');
  } else if (auth.key.kind !== 'fullAccess') {
    return reject('scope');
  }
  if (value > 0n) {
    const have = readBalance(auth.account, CLAWD);
    if (have < value) return reject('balance');
    auth.account.balances[CLAWD] = have - value;
    receiver.balances[CLAWD] = readBalance(receiver, CLAWD) + value;
  }
  receiver.calls += 1n;
  auth.account.nonces.set(publicKey, auth.nonce);
  return { ok: true, calls: receiver.calls, deposit: value };
}

function transfer(far, { accountId, publicKey, privateKey, receiverId, amount, asset = CLAWD, nonce } = {}) {
  const value = asInt(amount);
  if (value == null || value <= 0n) return reject('amount');
  if (typeof asset !== 'string' || asset.length === 0) return reject('asset');
  const action = { type: 'transfer', receiverId, amount: value.toString(), asset };
  const auth = authenticate(far, { accountId, publicKey, privateKey, nonce, action });
  if (!auth.ok) return auth;
  if (auth.key.kind !== 'fullAccess') return reject('scope');
  const receiver = far.accounts.get(receiverId);
  if (!receiver) return reject('account');
  if (auth.account.shard !== receiver.shard) return reject('receipt');
  const row = far.shards[auth.account.shard];
  if (row.queued >= row.capacity) return reject('queue');
  const fee = row.fee;
  const have = readBalance(auth.account, asset);
  if (asset === CLAWD) {
    if (have < value + fee) return reject('balance');
    auth.account.balances[CLAWD] = have - value - fee;
    row.collected += fee;
  } else {
    const clawd = readBalance(auth.account, CLAWD);
    if (have < value || clawd < fee) return reject('balance');
    auth.account.balances[asset] = have - value;
    auth.account.balances[CLAWD] = clawd - fee;
    row.collected += fee;
  }
  receiver.balances[asset] = readBalance(receiver, asset) + value;
  auth.account.nonces.set(publicKey, auth.nonce);
  return { ok: true, amount: value, fee, shard: auth.account.shard };
}

function runUnits(units) {
  if (!Number.isSafeInteger(units) || units <= 0) return Promise.resolve(0);
  return new Promise((resolve, rejectUnits) => {
    const worker = new Worker(WORKER_SOURCE, { eval: true, workerData: units });
    worker.once('message', resolve);
    worker.once('error', rejectUnits);
  });
}

async function commitShards(far, { plans, unitsPerAction = 0 } = {}) {
  if (!Array.isArray(plans) || plans.length === 0) return reject('shard');
  const quotesBefore = {};
  for (const id of SHARDS) quotesBefore[id] = quoteShard(far, id);
  const units = Number(unitsPerAction);
  if (!Number.isSafeInteger(units) || units < 0) return reject('shard');
  const started = process.hrtime.bigint();
  await Promise.all(plans.map(plan => runUnits((plan.actions ? plan.actions.length : 0) * units)));
  const elapsedNs = process.hrtime.bigint() - started;
  const applied = [];
  for (const plan of plans) {
    const row = far.shards[plan.shard];
    if (!row) {
      applied.push({ shard: plan.shard, ok: false, reason: 'shard' });
      continue;
    }
    if (row.queued >= row.capacity) {
      applied.push({
        shard: plan.shard,
        ok: false,
        reason: 'queue',
        fee: row.fee,
        delay: row.delay,
      });
      continue;
    }
    const results = [];
    let failed = null;
    for (const action of plan.actions || []) {
      const result = action.type === 'functionCall'
        ? functionCall(far, action)
        : transfer(far, { ...action, asset: action.asset || CLAWD });
      results.push(result);
      if (!result.ok && !failed) failed = result.reason;
    }
    applied.push({
      shard: plan.shard,
      ok: failed == null,
      reason: failed,
      fee: row.fee,
      delay: row.delay,
      results,
    });
  }
  const chunkId = sha256Hex(canonical({
    elapsed: elapsedNs.toString(),
    plans: plans.map(plan => ({
      shard: plan.shard,
      actions: (plan.actions || []).map(action => ({
        type: action.type || 'transfer',
        accountId: action.accountId,
        receiverId: action.receiverId,
        amount: action.amount == null ? null : String(action.amount),
        method: action.method || null,
        nonce: action.nonce == null ? null : String(action.nonce),
      })),
    })),
  }));
  far.chunks.set(chunkId, { id: chunkId, final: false, confirmations: 0, height: null });
  const quotes = {};
  for (const id of SHARDS) quotes[id] = quoteShard(far, id);
  return { ok: true, elapsedNs, chunkId, applied, quotesBefore, quotes };
}

function applyReceipt(far, { transfers } = {}) {
  if (!Array.isArray(transfers) || transfers.length === 0) return reject('receipt');
  const snap = snapshot(far);
  const shards = new Set();
  for (const leg of transfers) {
    const amount = asInt(leg.amount);
    const asset = leg.asset || CLAWD;
    if (amount == null || amount <= 0n || typeof asset !== 'string') {
      restore(far, snap);
      return reject('amount');
    }
    const from = far.accounts.get(leg.from);
    const to = far.accounts.get(leg.to);
    if (!from || !to) {
      restore(far, snap);
      return reject('account');
    }
    shards.add(from.shard);
    shards.add(to.shard);
    const have = readBalance(from, asset);
    if (have < amount) {
      restore(far, snap);
      return reject('balance');
    }
    from.balances[asset] = have - amount;
    to.balances[asset] = readBalance(to, asset) + amount;
  }
  return { ok: true, shards: [...shards], legs: transfers.length };
}

function normalizeDiffs(diffs) {
  if (!Array.isArray(diffs) || diffs.length === 0) return null;
  const clean = [];
  for (const diff of diffs) {
    if (!diff || typeof diff.asset !== 'string' || diff.asset.length === 0) return null;
    const amount = asInt(diff.amount);
    if (amount == null || amount === 0n) return null;
    clean.push({ asset: diff.asset, amount: amount.toString() });
  }
  clean.sort((a, b) => (a.asset < b.asset ? -1 : a.asset > b.asset ? 1 : (a.amount < b.amount ? -1 : 1)));
  return clean;
}

function signIntent(privateKey, publicKey, fields = {}) {
  if (Object.prototype.hasOwnProperty.call(fields, 'route') || fields.route != null) return reject('route');
  if (!isAccountId(fields.signerId)) return reject('account');
  const diffs = normalizeDiffs(fields.diffs);
  const deadline = asInt(fields.deadline);
  const nonce = asInt(fields.nonce);
  if (!diffs || deadline == null || deadline < 0n || nonce == null || nonce < 0n) return reject('intent');
  const body = canonical({
    protocol: 'far',
    signerId: fields.signerId,
    diffs,
    deadline: deadline.toString(),
    nonce: nonce.toString(),
  });
  if (body.includes('"route"')) return reject('route');
  let signature;
  try {
    signature = signBytes(privateKey, Buffer.from(body, 'utf8'));
  } catch {
    return reject('signature');
  }
  if (!verifyBytes(publicKey, Buffer.from(body, 'utf8'), signature)) return reject('signature');
  return {
    ok: true,
    intent: {
      kind: 'intent',
      signerId: fields.signerId,
      diffs,
      deadline,
      nonce,
      body,
      signature,
      publicKey,
    },
  };
}

function signFill(privateKey, publicKey, fields = {}) {
  if (Object.prototype.hasOwnProperty.call(fields, 'route') || fields.route != null) return reject('route');
  if (!isAccountId(fields.solverId) || typeof fields.intentId !== 'string') return reject('intent');
  const diffs = normalizeDiffs(fields.diffs);
  const deadline = asInt(fields.deadline);
  const nonce = asInt(fields.nonce);
  if (!diffs || deadline == null || nonce == null) return reject('intent');
  const body = canonical({
    protocol: 'far-fill',
    solverId: fields.solverId,
    intentId: fields.intentId,
    diffs,
    deadline: deadline.toString(),
    nonce: nonce.toString(),
  });
  let signature;
  try {
    signature = signBytes(privateKey, Buffer.from(body, 'utf8'));
  } catch {
    return reject('signature');
  }
  if (!verifyBytes(publicKey, Buffer.from(body, 'utf8'), signature)) return reject('signature');
  return {
    ok: true,
    fill: {
      kind: 'fill',
      signerId: fields.solverId,
      intentId: fields.intentId,
      diffs,
      deadline,
      nonce,
      body,
      signature,
      publicKey,
    },
  };
}

function intentIdOf(body) {
  return sha256Hex(body);
}

function keyAllowsIntent(account, publicKey) {
  const key = account && account.keys.get(publicKey);
  if (!key) return reject('key');
  if (key.kind !== 'fullAccess') return reject('scope');
  return { ok: true, key };
}

function submitIntent(far, intent) {
  if (!intent || intent.kind !== 'intent' || typeof intent.body !== 'string') return reject('intent');
  if (!verifyBytes(intent.publicKey, Buffer.from(intent.body, 'utf8'), intent.signature)) return reject('signature');
  if (intent.body.includes('"route"')) return reject('route');
  const account = far.accounts.get(intent.signerId);
  const allowed = keyAllowsIntent(account, intent.publicKey);
  if (!allowed.ok) return allowed;
  if (far.now > intent.deadline) return reject('deadline');
  const id = intentIdOf(intent.body);
  far.intents.set(id, intent);
  return { ok: true, intentId: id };
}

function submitFill(far, fill) {
  if (!fill || fill.kind !== 'fill' || typeof fill.body !== 'string') return reject('intent');
  if (!verifyBytes(fill.publicKey, Buffer.from(fill.body, 'utf8'), fill.signature)) return reject('signature');
  const account = far.accounts.get(fill.signerId);
  const allowed = keyAllowsIntent(account, fill.publicKey);
  if (!allowed.ok) return allowed;
  if (!far.intents.has(fill.intentId)) return reject('intent');
  if (far.now > fill.deadline) return reject('deadline');
  const id = intentIdOf(fill.body);
  far.fills.set(id, fill);
  return { ok: true, fillId: id };
}

function signedDiffs(part) {
  return part.diffs.map(diff => ({ asset: diff.asset, amount: BigInt(diff.amount) }));
}

function settle(far, { intentId, fillId, sink } = {}) {
  const intent = far.intents.get(intentId);
  const fill = far.fills.get(fillId);
  if (!intent || !fill || fill.intentId !== intentId) return reject('intent');
  if (far.now > intent.deadline || far.now > fill.deadline) return reject('deadline');
  if (!verifyBytes(intent.publicKey, Buffer.from(intent.body, 'utf8'), intent.signature)) return reject('signature');
  if (!verifyBytes(fill.publicKey, Buffer.from(fill.body, 'utf8'), fill.signature)) return reject('signature');
  const user = far.accounts.get(intent.signerId);
  const solver = far.accounts.get(fill.signerId);
  const userKey = keyAllowsIntent(user, intent.publicKey);
  const solverKey = keyAllowsIntent(solver, fill.publicKey);
  if (!userKey.ok) return userKey;
  if (!solverKey.ok) return solverKey;
  const userNonce = user.nonces.get(intent.publicKey);
  const solverNonce = solver.nonces.get(fill.publicKey);
  if (userNonce == null || solverNonce == null || intent.nonce <= userNonce || fill.nonce <= solverNonce) {
    return reject('nonce');
  }
  const totals = Object.create(null);
  const legs = [
    { account: user, diffs: signedDiffs(intent) },
    { account: solver, diffs: signedDiffs(fill) },
  ];
  if (sink) {
    const sinkAccount = far.accounts.get(sink.accountId);
    if (!sinkAccount) return reject('account');
    const sinkDiffs = normalizeDiffs(sink.diffs);
    if (!sinkDiffs) return reject('amount');
    legs.push({ account: sinkAccount, diffs: sinkDiffs.map(diff => ({ asset: diff.asset, amount: BigInt(diff.amount) })) });
  }
  for (const leg of legs) {
    for (const diff of leg.diffs) {
      totals[diff.asset] = (totals[diff.asset] || 0n) + diff.amount;
    }
  }
  for (const asset of Object.keys(totals)) {
    if (totals[asset] !== 0n) return reject('net');
  }
  const snap = snapshot(far);
  for (const leg of legs) {
    for (const diff of leg.diffs) {
      const next = readBalance(leg.account, diff.asset) + diff.amount;
      if (next < 0n) {
        restore(far, snap);
        return reject('balance');
      }
      leg.account.balances[diff.asset] = next;
    }
  }
  user.nonces.set(intent.publicKey, intent.nonce);
  solver.nonces.set(fill.publicKey, fill.nonce);
  return { ok: true, assets: Object.keys(totals) };
}

function produceBlock(far, { producer, chunkIds = [], work = [] } = {}) {
  const producerAccount = far.accounts.get(producer);
  if (!producerAccount) return reject('account');
  for (const id of chunkIds) {
    const chunk = far.chunks.get(id);
    if (!chunk) return reject('chunk');
    if (chunk.final) return reject('final');
  }
  const snap = snapshot(far);
  const included = [];
  let reward = 0n;
  for (const item of work) {
    const charge = chargeFor(item.kind);
    if (charge == null || item.outcome === 'invalid') {
      included.push({ kind: item.kind, applied: false, reason: 'invalid' });
      continue;
    }
    if (item.outcome === 'failed') {
      included.push({ kind: item.kind, applied: false, reason: 'failed' });
      continue;
    }
    const payer = far.accounts.get(item.payer);
    if (!payer || readBalance(payer, CLAWD) < charge) {
      included.push({ kind: item.kind, applied: false, reason: 'paid' });
      continue;
    }
    payer.balances[CLAWD] = readBalance(payer, CLAWD) - charge;
    reward += charge;
    included.push({ kind: item.kind, payer: item.payer, applied: true, charge });
  }
  producerAccount.balances[CLAWD] = readBalance(producerAccount, CLAWD) + reward;
  far.mined.set(producer, mined(far, producer) + reward);
  const height = far.height + 1n;
  far.height = height;
  for (const id of chunkIds) {
    const chunk = far.chunks.get(id);
    chunk.final = true;
    chunk.confirmations = 1;
    chunk.height = height;
  }
  const block = {
    height,
    producer,
    final: true,
    confirmations: 1,
    reward,
    included,
    chunkIds: [...chunkIds],
  };
  far.blocks.push(block);
  if (reward !== included.filter(item => item.applied).reduce((sum, item) => sum + item.charge, 0n)) {
    restore(far, snap);
    return reject('work');
  }
  return { ok: true, block, mined: mined(far, producer) };
}

function isFinal(far, chunkId) {
  const chunk = far.chunks.get(chunkId);
  if (!chunk) return { ok: false, reason: 'chunk', final: false, confirmations: 0 };
  return { ok: true, final: chunk.final === true, confirmations: chunk.confirmations, height: chunk.height };
}

function dropBlock(far, height) {
  const wanted = asInt(height);
  const block = far.blocks.find(item => item.height === wanted);
  if (!block) return reject('block');
  if (block.final || block.confirmations >= 1) return reject('final');
  return reject('final');
}

module.exports = {
  CLAWD,
  SHARDS,
  WORK_KINDS,
  SPEED_UNITS,
  createFar,
  setTime,
  balance,
  mined,
  chargeFor,
  quoteShard,
  setShard,
  fillQueue,
  createAccount,
  addKey,
  functionCall,
  transfer,
  commitShards,
  applyReceipt,
  signIntent,
  signFill,
  submitIntent,
  submitFill,
  settle,
  produceBlock,
  isFinal,
  dropBlock,
};
