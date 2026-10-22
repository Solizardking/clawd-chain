// Ring buffer of recent faucet airdrops plus SSE fan-out. Public on-chain data only.
function createFeed(opts = {}) {
  const size = opts.size || 50;
  const items = [];
  const clients = new Set();
  function push(row) {
    const item = { signature: String(row.signature), to: String(row.to), amount: Number(row.amount), t: row.t || Date.now() };
    items.unshift(item);
    if (items.length > size) items.length = size;
    const frame = `event: airdrop\ndata: ${JSON.stringify(item)}\n\n`;
    for (const res of clients) { try { res.write(frame); } catch { clients.delete(res); } }
    return item;
  }
  function recent(limit = 20) { return items.slice(0, Math.max(1, Math.min(size, Number(limit) || 20))); }
  function subscribe(req, res, headers = {}) {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no', ...headers });
    res.write(`retry: 3000\nevent: hello\ndata: ${JSON.stringify({ recent: recent(20) })}\n\n`);
    clients.add(res);
    const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 20000);
    req.on('close', () => { clearInterval(ping); clients.delete(res); });
  }
  return { push, recent, subscribe, clients: () => clients.size };
}
module.exports = { createFeed };
