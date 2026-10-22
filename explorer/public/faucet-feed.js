// Live faucet airdrop feed for the home page. SSE first, polling fallback.
(function (root) {
  const short = s => (s && s.length > 12 ? s.slice(0, 4) + '…' + s.slice(-4) : String(s || ''));
  const ago = (t, now) => { const s = Math.max(0, Math.round(((now || Date.now()) - t) / 1000)); return s < 60 ? s + 's ago' : s < 3600 ? Math.floor(s / 60) + 'm ago' : Math.floor(s / 3600) + 'h ago'; };
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const ok = s => /^[1-9A-HJ-NP-Za-km-z]{32,90}$/.test(s || '');
  function row(it, fresh) {
    if (!ok(it.signature) || !ok(it.to)) return '';
    return `<li class="ff-row${fresh ? ' ff-new' : ''}" data-sig="${esc(it.signature)}"><span class="ff-claw">🦞</span>`
      + `<a class="ff-sig" href="/tx/${esc(it.signature)}">${esc(short(it.signature))}</a>`
      + `<span class="ff-to">→ <a href="/address/${esc(it.to)}">${esc(short(it.to))}</a></span>`
      + `<span class="ff-amt">+${esc(Number(it.amount) || 0)} CLAWD</span>`
      + `<time class="ff-t" data-t="${Number(it.t) || 0}">${ago(it.t)}</time></li>`;
  }
  function mount(el, opts = {}) {
    const doc = el.ownerDocument;
    const seen = new Set();
    let items = [];
    const render = fresh => {
      el.innerHTML = items.length ? items.map(it => row(it, fresh && fresh.has(it.signature))).join('')
        : '<li class="ff-empty">No airdrops yet. <a href="https://faucet.clawdchain.trade">Be the first lobster →</a></li>';
    };
    const add = (list, live) => {
      const fresh = new Set();
      for (const it of list.slice().reverse()) { if (seen.has(it.signature)) continue; seen.add(it.signature); items.unshift(it); if (live) fresh.add(it.signature); }
      items = items.slice(0, opts.max || 15);
      render(fresh);
      const c = doc.getElementById('ff-count'); if (c) c.textContent = items.length;
    };
    const poll = () => (root.fetch ? root.fetch('/api/faucet/recent').then(r => r.json()).then(j => add(j.items || [], seen.size > 0)).catch(() => {}) : null);
    let timer = null;
    const startPoll = () => { if (!timer) timer = setInterval(poll, opts.pollMs || 4000); };
    if (root.EventSource && !opts.noStream) {
      const es = new root.EventSource('/api/faucet/stream');
      es.addEventListener('hello', e => { try { add(JSON.parse(e.data).recent || [], false); } catch {} });
      es.addEventListener('airdrop', e => { try { add([JSON.parse(e.data)], true); } catch {} });
      es.onerror = () => { startPoll(); };
    } else { poll(); startPoll(); }
    setInterval(() => { for (const t of el.querySelectorAll('time[data-t]')) t.textContent = ago(+t.dataset.t); }, 1000);
    render();
    return { add, items: () => items };
  }
  const api = { mount, row, short, ago };
  root.ClawdFaucetFeed = api;
  if (typeof module !== 'undefined') module.exports = api;
  if (root.document) root.document.addEventListener('DOMContentLoaded', () => { const el = root.document.getElementById('faucet-feed'); if (el) mount(el); });
})(typeof window !== 'undefined' ? window : globalThis);
