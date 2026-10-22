// Content-addressed bytes, a model repo record, and an append-only process log.
const { canonical, sha256Hex } = require('./codec');
const { publicKeyHex, signBytes, verifyBytes } = require('./sign');

function contentId(bytes) {
  const data = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  return sha256Hex(data);
}

function createStore() {
  const objects = new Map();
  const models = [];
  return {
    put(bytes) {
      const data = Buffer.isBuffer(bytes) ? Buffer.from(bytes) : Buffer.from(bytes);
      const id = contentId(data);
      if (!objects.has(id)) objects.set(id, data);
      return id;
    },
    get(id) {
      const data = objects.get(id);
      return data ? Buffer.from(data) : null;
    },
    models,
  };
}

function storeModel(store, { repoId, revision, bytes } = {}) {
  if (typeof repoId !== 'string' || repoId.trim().length === 0) throw new Error('repo id');
  if (typeof revision !== 'string' || revision.trim().length === 0) throw new Error('revision');
  const digest = store.put(bytes);
  const record = { repoId: repoId.trim(), revision: revision.trim(), digest };
  store.models.push(record);
  return record;
}

function emptyState() {
  return { seq: 0, store: {} };
}

function replay(log) {
  const state = emptyState();
  for (const entry of log) {
    const bytes = Buffer.from(entry.payload, 'utf8');
    if (!verifyBytes(entry.signer, bytes, entry.signature)) {
      throw new Error('bad signature');
    }
    if (canonical(entry.body) !== entry.payload) throw new Error('payload mismatch');
    state.seq += 1;
    if (entry.body && entry.body.op === 'set') {
      state.store[entry.body.key] = entry.body.value;
    }
  }
  return state;
}

function openProcess(identity) {
  const signer = publicKeyHex(identity.publicKey);
  return {
    id: sha256Hex(Buffer.from('clawd-ao-process:' + signer)),
    signer,
    log: [],
    state: emptyState(),
  };
}

function appendMessage(process, identity, body) {
  const signer = publicKeyHex(identity.publicKey);
  if (signer !== process.signer) return { ok: false, reason: 'signer' };
  const payload = canonical(body);
  const signature = signBytes(identity.privateKey, Buffer.from(payload, 'utf8'));
  const entry = { signer, payload, signature, body };
  const nextLog = process.log.concat([entry]);
  const state = replay(nextLog);
  process.log.push(entry);
  process.state = state;
  return { ok: true, state };
}

module.exports = {
  contentId,
  createStore,
  storeModel,
  openProcess,
  appendMessage,
  replay,
};
