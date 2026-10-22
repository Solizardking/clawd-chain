// Supermemory v5 client. The API key is read from the environment and never logged.
const DEFAULT_BASE = 'https://api.supermemory.ai';
const DEFAULT_NAMESPACE = 'clawd-chain';

function scrub(key, value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  if (!key) return text.slice(0, 300);
  return text.split(key).join('[redacted]').slice(0, 300);
}

function cleanDoc(doc) {
  const out = { content: String(doc.content || '').slice(0, 12000) };
  if (doc.id) out.id = String(doc.id).slice(0, 255);
  if (doc.supportingContext) out.supportingContext = String(doc.supportingContext).slice(0, 1500);
  if (doc.metadata && typeof doc.metadata === 'object') out.metadata = doc.metadata;
  if (doc.group) out.group = String(doc.group).slice(0, 100);
  if (doc.date) out.date = doc.date;
  return out;
}

function createMemory(opts = {}) {
  const key = opts.key ?? process.env.SUPERMEMORY_API_KEY ?? '';
  const fetchImpl = opts.fetch || globalThis.fetch;
  const base = String(opts.base || process.env.SUPERMEMORY_API_BASE || DEFAULT_BASE).replace(/\/$/, '');
  const namespace = opts.namespace || process.env.BRAIN_NAMESPACE || DEFAULT_NAMESPACE;
  const dreaming = opts.dreaming || process.env.BRAIN_DREAMING || 'instant';
  const taskType = opts.taskType || 'memory';

  function headers() {
    if (!key) throw new Error('SUPERMEMORY_API_KEY is not set');
    return { authorization: `Bearer ${key}`, 'content-type': 'application/json' };
  }

  async function post(path, body) {
    const res = await fetchImpl(`${base}/ns/${encodeURIComponent(namespace)}${path}`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    if (!res.ok) {
      const detail = json && (json.message || json.error) ? json.message || json.error : text;
      throw new Error(`supermemory ${res.status}: ${scrub(key, detail)}`);
    }
    return json;
  }

  async function addDocuments(documents) {
    const docs = (documents || []).filter(Boolean).map(cleanDoc);
    if (!docs.length) return { count: 0, failed: 0 };
    let failed = 0;
    for (let i = 0; i < docs.length; i += 100) {
      const res = await post('/document/batch', { documents: docs.slice(i, i + 100), taskType, dreaming });
      failed += Number(res?.failed || 0);
      if (res?.failed) throw new Error(`supermemory batch failed ${res.failed}`);
    }
    return { count: docs.length, failed };
  }

  async function search(query, extra = {}) {
    const q = String(query || '').trim();
    if (!q) throw new Error('query is required');
    const limit = Math.min(100, Math.max(1, Number(extra.limit) || 10));
    return post('/search', { query: q, searchMode: extra.searchMode || 'hybrid', limit });
  }

  return { addDocuments, search, namespace, configured: () => Boolean(key) };
}

module.exports = { createMemory, scrub, cleanDoc };
