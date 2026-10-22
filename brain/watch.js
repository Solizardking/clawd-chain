// Walk confirmed slots and remember each transaction. The cursor moves only after
// a successful Supermemory write, so a failed batch is retried.
const { txDocument, snapshotDocument } = require('./format');

const BLOCK_CONFIG = {
  encoding: 'jsonParsed',
  transactionDetails: 'full',
  rewards: false,
  maxSupportedTransactionVersion: 0,
  commitment: 'confirmed',
};

async function rpc(url, method, params, fetchImpl) {
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  if (!res.ok) throw new Error(`rpc ${method} http ${res.status}`);
  const json = await res.json();
  if (json.error) throw new Error(json.error.message || `rpc ${method} failed`);
  return json.result;
}

function skippedSlot(err) {
  return /skipped|not available|cleaned up|ledger jump|Block not available|Slot .* was skipped/i.test(String(err && err.message || err));
}

function createWatcher(opts) {
  const fetchImpl = opts.fetch || globalThis.fetch;
  const rpcUrl = opts.rpc;
  const memory = opts.memory;
  const windowSize = Math.max(1, Number(opts.window) || 8);
  const pauseMs = Math.max(0, Number(opts.pauseMs) || 0);
  const fromSlot = Number.isFinite(Number(opts.fromSlot)) ? Number(opts.fromSlot) : 0;
  const snapshotEvery = Math.max(0, Number(opts.snapshotEvery ?? 100));
  const state = opts.state || { cursor: null, indexed: 0, snapshots: 0, lastError: null, slot: 0 };

  async function tick() {
    const slot = Number(await rpc(rpcUrl, 'getSlot', [{ commitment: 'confirmed' }], fetchImpl));
    state.slot = slot;
    const cursor = state.cursor == null ? Math.max(-1, fromSlot - 1) : Number(state.cursor);
    if (cursor >= slot) return state;
    const start = cursor + 1;
    const end = Math.min(slot, start + windowSize - 1);
    const slots = await rpc(rpcUrl, 'getBlocks', [start, end, { commitment: 'confirmed' }], fetchImpl) || [];
    const docs = [];
    let txCount = 0;
    let snapshotSlot = null;
    for (const s of slots) {
      if (pauseMs) await new Promise(r => setTimeout(r, pauseMs));
      let block;
      try {
        block = await rpc(rpcUrl, 'getBlock', [s, BLOCK_CONFIG], fetchImpl);
      } catch (err) {
        if (skippedSlot(err)) continue;
        throw err;
      }
      if (!block) continue;
      for (const entry of block.transactions || []) {
        const doc = txDocument({ slot: s, blockTime: block.blockTime, entry });
        if (!doc) continue;
        docs.push(doc);
        txCount += 1;
      }
      if (snapshotEvery && Number(s) % snapshotEvery === 0) snapshotSlot = Number(s);
    }
    if (snapshotSlot != null) {
      const epoch = await rpc(rpcUrl, 'getEpochInfo', [{ commitment: 'confirmed' }], fetchImpl);
      const supply = await rpc(rpcUrl, 'getSupply', [{ commitment: 'confirmed' }], fetchImpl);
      docs.push(snapshotDocument({
        slot: snapshotSlot,
        epoch: epoch?.epoch,
        blockHeight: epoch?.blockHeight,
        transactionCount: epoch?.transactionCount,
        total: supply?.value?.total,
        circulating: supply?.value?.circulating,
      }));
    }
    if (docs.length) await memory.addDocuments(docs);
    state.cursor = end;
    state.indexed += txCount;
    if (snapshotSlot != null) state.snapshots += 1;
    state.lastError = null;
    return state;
  }

  return { tick, state };
}

module.exports = { createWatcher, skippedSlot, BLOCK_CONFIG };
