'use strict';
// clawd chain price keeper. Read-only: it signs nothing and holds no keys.
// Pulls Phoenix mark mids (WebSocket allMids, REST-free) for SOL/BTC and a DexScreener
// USD price for CLAWD, clamps each move to the market's max_price_move_bps_per_slot,
// and writes PRICES_FILE (default /data/prices.json) in Percolator units (1e6 = 1 cUSD).
// The percolator-launch server reads that file to quote the house LP's trade price.
const fs = require('fs');
const path = require('path');
const PHOENIX_WS = process.env.PHOENIX_WS || 'wss://perp-api.phoenix.trade/v1/ws';
const CLAWD_TOKEN = process.env.CLAWD_TOKEN || '';
const OUT = process.env.PRICES_FILE || '/data/prices.json';
const MAX_BPS_PER_TICK = Number(process.env.MAX_MOVE_BPS || 100);
const TICK_MS = Number(process.env.TICK_MS || 2000);
const STALE_MS = Number(process.env.STALE_MS || 30000);
const MARKETS = { 'SOL-PERP': { src: 'phoenix', sym: 'SOL' }, 'BTC-PERP': { src: 'phoenix', sym: 'BTC' }, 'CLAWD-PERP': { src: 'dex', unit: Number(process.env.CLAWD_UNIT || 1e6) } }; // CLAWD quoted per 1M CLAWD
const SCALE = 1e6;

const mids = {}; let midsAt = 0;
function clamp(prev, next, maxBps) {
  if (!prev) return next;
  const lim = (prev * maxBps) / 10000;
  return Math.max(prev - lim, Math.min(prev + lim, next));
}
function connect() {
  const ws = new WebSocket(PHOENIX_WS);
  ws.onopen = () => ws.send(JSON.stringify({ type: 'subscribe', subscription: { channel: 'allMids' } }));
  ws.onmessage = (e) => { try { const m = JSON.parse(e.data); if (m.channel === 'allMids') { Object.assign(mids, m.mids); midsAt = Date.now(); } } catch {} };
  ws.onclose = ws.onerror = () => { try { ws.close(); } catch {} setTimeout(connect, 3000); };
}
let dexPx = 0, dexAt = 0;
async function pollDex() {
  if (!CLAWD_TOKEN) return;
  try {
    const r = await fetch('https://api.dexscreener.com/latest/dex/tokens/' + CLAWD_TOKEN, { signal: AbortSignal.timeout(8000) });
    const j = await r.json();
    const p = (j.pairs || []).filter((x) => x.priceUsd).sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
    if (p) { dexPx = Number(p.priceUsd); dexAt = Date.now(); }
  } catch {}
}
function read() { try { return JSON.parse(fs.readFileSync(OUT, 'utf8')); } catch { return { markets: {} }; } }
function tick() {
  const prev = read().markets || {};
  const out = { updatedAt: new Date().toISOString(), scale: SCALE, markets: {} };
  for (const [name, m] of Object.entries(MARKETS)) {
    const raw = (m.src === 'phoenix' ? Number(mids[m.sym]) : dexPx) * (m.unit || 1);
    const at = m.src === 'phoenix' ? midsAt : dexAt;
    const fresh = raw > 0 && Date.now() - at < STALE_MS;
    const p0 = prev[name] && prev[name].price;
    const price = fresh ? Math.round(clamp(p0, raw * SCALE, MAX_BPS_PER_TICK)) : p0 || 0;
    out.markets[name] = { price, source: m.src, raw: fresh ? raw : null, stale: !fresh, clamped: fresh && price !== Math.round(raw * SCALE) };
  }
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT + '.tmp', JSON.stringify(out));
  fs.renameSync(OUT + '.tmp', OUT);
  return out;
}
module.exports = { clamp, tick, MARKETS };
if (require.main === module) {
  connect(); pollDex(); setInterval(pollDex, 15000);
  setInterval(() => { const o = tick(); if (process.env.ONCE) { console.log(JSON.stringify(o)); process.exit(0); } }, TICK_MS);
}
