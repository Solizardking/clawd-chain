// Public self-serve registry of x402-paid resources and x402 facilitators.
// Listing only: nothing here signs, verifies, settles, or moves funds.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const KINDS = ['resource', 'facilitator'];
const SCHEMES = ['exact', 'x402', 'mpp'];
const ADDR = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const MAX_ENTRIES = 5000;

function clean(value, max) {
  if (value === undefined || value === null) return '';
  return String(value).replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, max);
}

function httpsUrl(value, allowHttp) {
  try {
    const u = new URL(String(value || ''));
    if (u.protocol !== 'https:' && !(allowHttp && u.protocol === 'http:')) return null;
    if (u.username || u.password) return null;
    const host = u.hostname.toLowerCase();
    if (!allowHttp && (host === 'localhost' || /^(127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host) || host === '[::1]')) return null;
    return u.toString().slice(0, 300);
  } catch { return null; }
}

function validate(kind, input, opts = {}) {
  const errors = [];
  if (!KINDS.includes(kind)) return { ok: false, errors: ['kind must be resource or facilitator'] };
  const body = input && typeof input === 'object' ? input : {};
  const name = clean(body.name, 80);
  if (name.length < 2) errors.push('name is required (2-80 chars)');
  const url = httpsUrl(body.url, opts.allowHttp);
  if (!url) errors.push('url must be a public https URL');
  const description = clean(body.description, 500);
  const network = clean(body.network || 'clawd', 32).toLowerCase();
  if (!/^[a-z0-9:_-]{2,32}$/.test(network)) errors.push('network must be a short id such as clawd or solana');
  const schemes = Array.isArray(body.schemes) && body.schemes.length ? body.schemes.map(s => clean(s, 16).toLowerCase()) : ['exact'];
  if (!schemes.every(s => SCHEMES.includes(s))) errors.push('schemes must be from ' + SCHEMES.join(', '));
  const tags = (Array.isArray(body.tags) ? body.tags : []).slice(0, 8).map(t => clean(t, 24).toLowerCase()).filter(Boolean);
  const contact = clean(body.contact, 120);
  const entry = { kind, name, url, description, network, schemes: [...new Set(schemes)], tags, contact };
  if (kind === 'resource') {
    const price = clean(body.price, 24);
    if (!/^\d{1,20}$/.test(price)) errors.push('price must be an integer amount in base units (lamports)');
    const payTo = clean(body.payTo, 44);
    if (!ADDR.test(payTo)) errors.push('payTo must be a base58 address');
    const method = clean(body.method || 'GET', 8).toUpperCase();
    if (!['GET', 'POST'].includes(method)) errors.push('method must be GET or POST');
    const facilitator = body.facilitator ? httpsUrl(body.facilitator, opts.allowHttp) : null;
    if (body.facilitator && !facilitator) errors.push('facilitator must be a public https URL');
    Object.assign(entry, { price, asset: clean(body.asset || 'CLAWD', 16), payTo, method, facilitator });
  } else {
    const feePayer = clean(body.feePayer, 44);
    if (feePayer && !ADDR.test(feePayer)) errors.push('feePayer must be a base58 address');
    entry.feePayer = feePayer || null;
  }
  return errors.length ? { ok: false, errors } : { ok: true, entry };
}

function createRegistry(opts = {}) {
  const file = opts.file === undefined ? process.env.REGISTRY_FILE || '' : opts.file;
  const perWindow = opts.perWindow || 5;
  const windowMs = opts.windowMs || 60 * 60 * 1000;
  const allowHttp = Boolean(opts.allowHttp);
  let entries = [];
  const hits = new Map();
  if (file) {
    try { entries = JSON.parse(fs.readFileSync(file, 'utf8')).entries || []; } catch { entries = []; }
  }
  function save() {
    if (!file) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, entries }, null, 2));
    fs.renameSync(tmp, file);
  }
  function limited(ip, now = Date.now()) {
    const row = (hits.get(ip) || []).filter(t => now - t < windowMs);
    if (row.length >= perWindow) { hits.set(ip, row); return true; }
    row.push(now); hits.set(ip, row); return false;
  }
  function add(kind, input, ip = 'local') {
    const checked = validate(kind, input, { allowHttp });
    if (!checked.ok) return { status: 400, body: { error: 'invalid entry', errors: checked.errors } };
    if (entries.some(e => e.kind === kind && e.url === checked.entry.url)) return { status: 409, body: { error: 'url already registered' } };
    if (entries.length >= MAX_ENTRIES) return { status: 507, body: { error: 'registry full' } };
    if (limited(ip)) return { status: 429, body: { error: `rate limited: ${perWindow} registrations per hour` } };
    const entry = { id: crypto.randomBytes(8).toString('hex'), ...checked.entry, createdAt: new Date().toISOString() };
    entries.push(entry);
    save();
    return { status: 201, body: entry };
  }
  function list(kind, query = {}) {
    const q = clean(query.q, 80).toLowerCase();
    const network = clean(query.network, 32).toLowerCase();
    const limit = Math.min(100, Math.max(1, Number(query.limit) || 50));
    const offset = Math.max(0, Number(query.offset) || 0);
    const rows = entries.filter(e => (!kind || e.kind === kind)
      && (!network || e.network === network)
      && (!q || [e.name, e.description, ...(e.tags || [])].join(' ').toLowerCase().includes(q)))
      .slice().reverse();
    return { total: rows.length, offset, limit, items: rows.slice(offset, offset + limit) };
  }
  function get(id) { return entries.find(e => e.id === id) || null; }
  return { add, list, get, validate, count: () => entries.length };
}

module.exports = { createRegistry, validate, KINDS, SCHEMES };
