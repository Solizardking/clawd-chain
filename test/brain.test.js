const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { txDocument, snapshotDocument } = require('../brain/format');
const { createMemory } = require('../brain/memory');
const { createWatcher } = require('../brain/watch');
const { createBrainServer, loadDotEnv, saveState, loadState } = require('../brain/server');

const SIG = '4vtNvDe4mgN2ZLGi22E39zaHcNSMCcKsa3qjr2qruERqTgVyACSLpMD8jD9ywd932iQC69piwNtL9mM8XpJTqayu';

function entry() {
  return {
    transaction: {
      signatures: [SIG],
      message: {
        accountKeys: [
          { pubkey: 'DkGyMKvqX1cXZqsDpobEgLdsWbqfoq4haSgBT57bPvRv', signer: true, writable: true },
          { pubkey: 'EfPjf4yZntT3RL2f3nHpMHRGrhE64TRyregn1aHSeRXc', signer: false, writable: true },
          { pubkey: 'TokenAta11111111111111111111111111111111111', signer: false, writable: true },
        ],
        instructions: [{
          program: 'system',
          programId: '11111111111111111111111111111111',
          parsed: { type: 'transfer', info: { source: 'DkGyMKvqX1cXZqsDpobEgLdsWbqfoq4haSgBT57bPvRv', destination: 'EfPjf4yZntT3RL2f3nHpMHRGrhE64TRyregn1aHSeRXc', lamports: 5000000000 } },
        }],
      },
    },
    meta: {
      err: null,
      fee: 5000,
      preBalances: [10000000000, 0, 0],
      postBalances: [4999995000, 5000000000, 0],
      preTokenBalances: [],
      postTokenBalances: [{
        accountIndex: 2,
        mint: 'Mint111111111111111111111111111111111111111',
        owner: 'EfPjf4yZntT3RL2f3nHpMHRGrhE64TRyregn1aHSeRXc',
        programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
        uiTokenAmount: { amount: '1500000000', decimals: 9, uiAmountString: '1.5' },
      }],
      logMessages: ['Program 11111111111111111111111111111111 success'],
    },
  };
}

test('transaction document keeps the signature, CLAWD move, and token delta', () => {
  const doc = txDocument({ slot: 18548, blockTime: 1792024287, entry: entry() });
  assert.equal(doc.id, `tx-${SIG}`);
  assert.equal(doc.metadata.kind, 'tx');
  assert.equal(doc.metadata.status, 'ok');
  assert.equal(doc.metadata.slot, 18548);
  assert.equal(doc.metadata.signer, 'DkGyMKvqX1cXZqsDpobEgLdsWbqfoq4haSgBT57bPvRv');
  assert.deepEqual(doc.metadata.mints, ['Mint111111111111111111111111111111111111111']);
  assert.match(doc.content, new RegExp(SIG));
  assert.match(doc.content, /status: ok/);
  assert.match(doc.content, /EfPjf4yZntT3RL2f3nHpMHRGrhE64TRyregn1aHSeRXc \+5 CLAWD/);
  assert.match(doc.content, /mint Mint111111111111111111111111111111111111111 owner EfPjf4yZntT3RL2f3nHpMHRGrhE64TRyregn1aHSeRXc \+1\.5/);
  assert.match(doc.content, /Token \(TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA\)/);
  assert.match(doc.content, /System \(11111111111111111111111111111111\) transfer/);
  assert.equal(doc.date, new Date(1792024287 * 1000).toISOString());
});

test('failed transactions are stored with status err', () => {
  const failed = entry();
  failed.meta.err = { InstructionError: [0, 'InsufficientFunds'] };
  const doc = txDocument({ slot: 9, blockTime: null, entry: failed });
  assert.equal(doc.metadata.status, 'err');
  assert.match(doc.content, /InsufficientFunds/);
  assert.equal(doc.date, undefined);
});

test('a transaction without a signature is skipped', () => {
  assert.equal(txDocument({ slot: 1, blockTime: null, entry: { transaction: { signatures: [] }, meta: {} } }), null);
});

test('snapshot document records supply in CLAWD', () => {
  const doc = snapshotDocument({ slot: 100, epoch: 0, blockHeight: 100, transactionCount: 3, total: 5000000000, circulating: 5000000000 });
  assert.equal(doc.id, 'snapshot-100');
  assert.equal(doc.metadata.kind, 'snapshot');
  assert.match(doc.content, /slot: 100/);
  assert.match(doc.content, /supply: 5000000000 lamports \(5 CLAWD\)/);
  assert.match(doc.content, /transaction count: 3/);
});

function okJson(obj) {
  const text = JSON.stringify(obj);
  return { ok: true, status: 200, text: async () => text, json: async () => obj };
}

test('batch ingest posts to the clawd-chain namespace and does not echo the key in errors', async () => {
  let seen;
  const memory = createMemory({
    key: 'sm_test_key',
    fetch: async (url, init) => {
      seen = { url, headers: init.headers, body: JSON.parse(init.body) };
      return okJson({ results: [{ id: 'doc', status: 'queued' }], count: 1, failed: 0 });
    },
  });
  const out = await memory.addDocuments([{ id: `tx-${SIG}`, content: 'clawd chain transaction', metadata: { kind: 'tx', slot: 1 } }]);
  assert.equal(out.count, 1);
  assert.equal(seen.url, 'https://api.supermemory.ai/ns/clawd-chain/document/batch');
  assert.equal(seen.headers.authorization, 'Bearer sm_test_key');
  assert.equal(seen.body.taskType, 'memory');
  assert.equal(seen.body.dreaming, 'instant');
  assert.equal(seen.body.documents[0].id, `tx-${SIG}`);

  const denied = createMemory({
    key: 'sm_test_key',
    fetch: async () => ({ ok: false, status: 401, text: async () => 'unauthorized sm_test_key' }),
  });
  await assert.rejects(() => denied.search('who received CLAWD'), err => {
    assert.match(err.message, /supermemory 401/);
    assert.equal(err.message.includes('sm_test_key'), false);
    assert.match(err.message, /\[redacted\]/);
    return true;
  });
});

test('a missing key never calls the network', async () => {
  let called = false;
  const memory = createMemory({ key: '', fetch: async () => { called = true; return okJson({}); } });
  await assert.rejects(() => memory.addDocuments([{ content: 'x', id: 'tx-1' }]), /SUPERMEMORY_API_KEY is not set/);
  await assert.rejects(() => memory.search('tokens'), /SUPERMEMORY_API_KEY is not set/);
  assert.equal(called, false);
});

test('search posts the query', async () => {
  let seen;
  const memory = createMemory({
    key: 'sm_test_key',
    fetch: async (url, init) => {
      seen = { url, body: JSON.parse(init.body) };
      return okJson({ results: [], searchTime: 1 });
    },
  });
  await memory.search('  mint movements  ', { limit: 3 });
  assert.equal(seen.url, 'https://api.supermemory.ai/ns/clawd-chain/search');
  assert.deepEqual(seen.body, { query: 'mint movements', searchMode: 'hybrid', limit: 3 });
});

function rpcFetch(handlers) {
  const calls = [];
  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body.method);
    const result = await handlers[body.method](body.params);
    return { ok: true, json: async () => ({ result }) };
  };
  return { fetchImpl, calls };
}

test('watcher remembers one block, writes a snapshot, and does not repeat the slot', async () => {
  const docs = [];
  const { fetchImpl, calls } = rpcFetch({
    getSlot: async () => 100,
    getBlocks: async () => [100],
    getBlock: async () => ({ blockTime: 1792024287, transactions: [entry()] }),
    getEpochInfo: async () => ({ epoch: 0, blockHeight: 100, transactionCount: 4 }),
    getSupply: async () => ({ value: { total: 5000000000, circulating: 5000000000 } }),
  });
  const watcher = createWatcher({
    rpc: 'http://127.0.0.1:8899',
    fetch: fetchImpl,
    fromSlot: 0,
    window: 128,
    snapshotEvery: 100,
    memory: { addDocuments: async batch => { docs.push(...batch); } },
  });
  await watcher.tick();
  assert.equal(watcher.state.cursor, 100);
  assert.equal(watcher.state.indexed, 1);
  assert.equal(watcher.state.snapshots, 1);
  assert.equal(docs[0].id, `tx-${SIG}`);
  assert.equal(docs[1].id, 'snapshot-100');
  const before = calls.length;
  await watcher.tick();
  assert.deepEqual(calls.slice(before), ['getSlot']);
  assert.equal(docs.length, 2);
});

test('a failed memory write leaves the cursor where it was', async () => {
  const { fetchImpl } = rpcFetch({
    getSlot: async () => 5,
    getBlocks: async () => [4, 5],
    getBlock: async () => ({ blockTime: null, transactions: [entry()] }),
  });
  const watcher = createWatcher({
    rpc: 'http://127.0.0.1:8899',
    fetch: fetchImpl,
    fromSlot: 4,
    window: 16,
    snapshotEvery: 0,
    memory: { addDocuments: async () => { throw new Error('supermemory down'); } },
  });
  await assert.rejects(() => watcher.tick(), /supermemory down/);
  assert.equal(watcher.state.cursor, null);
  assert.equal(watcher.state.indexed, 0);
});

test('a skipped slot advances the cursor without a document', async () => {
  const { fetchImpl } = rpcFetch({
    getSlot: async () => 8,
    getBlocks: async () => [7],
    getBlock: async () => { throw new Error('Slot 7 was skipped, or missing in long-term storage'); },
  });
  let called = false;
  const watcher = createWatcher({
    rpc: 'http://127.0.0.1:8899',
    fetch: fetchImpl,
    fromSlot: 7,
    window: 4,
    snapshotEvery: 0,
    memory: { addDocuments: async () => { called = true; } },
  });
  await watcher.tick();
  assert.equal(watcher.state.cursor, 8);
  assert.equal(watcher.state.indexed, 0);
  assert.equal(called, false);
});

test('search route returns memories and health hides nothing secret', async () => {
  const state = { cursor: 4, indexed: 2, snapshots: 1, lastError: null, slot: 9 };
  const server = createBrainServer({
    memory: { namespace: 'clawd-chain', search: async query => ({ results: [{ memory: query }] }) },
    state,
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = server.address().port;
    const health = await fetch(`http://127.0.0.1:${port}/health`);
    const body = await health.json();
    assert.equal(body.ok, true);
    assert.equal(body.indexed, 2);
    assert.equal(JSON.stringify(body).includes('SUPERMEMORY'), false);
    const found = await fetch(`http://127.0.0.1:${port}/search`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'token mint', limit: 5 }),
    });
    const searched = await found.json();
    assert.equal(searched.results[0].memory, 'token mint');
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('dotenv loader does not override an existing value', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-env-'));
  const file = path.join(dir, '.env');
  fs.writeFileSync(file, 'BRAIN_FROM=12\nSUPERMEMORY_API_KEY=sm_from_file\n');
  const previousFrom = process.env.BRAIN_FROM;
  const previousKey = process.env.SUPERMEMORY_API_KEY;
  process.env.BRAIN_FROM = '0';
  delete process.env.SUPERMEMORY_API_KEY;
  try {
    loadDotEnv(file);
    assert.equal(process.env.BRAIN_FROM, '0');
    assert.equal(process.env.SUPERMEMORY_API_KEY, 'sm_from_file');
  } finally {
    if (previousFrom == null) delete process.env.BRAIN_FROM;
    else process.env.BRAIN_FROM = previousFrom;
    if (previousKey == null) delete process.env.SUPERMEMORY_API_KEY;
    else process.env.SUPERMEMORY_API_KEY = previousKey;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('cursor state round-trips without the api key', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-state-'));
  const file = path.join(dir, 'brain-state.json');
  saveState(file, { cursor: 42, indexed: 7, snapshots: 1, slot: 42, lastError: 'sm_test_key' });
  const loaded = loadState(file);
  assert.equal(loaded.cursor, 42);
  assert.equal(loaded.indexed, 7);
  assert.equal(loaded.lastError, null);
  assert.equal(fs.readFileSync(file, 'utf8').includes('sm_test_key'), false);
  fs.rmSync(dir, { recursive: true, force: true });
});
