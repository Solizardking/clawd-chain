// Thin HTTP front for Clawd asset reads. No outside asset host.
const http = require('http');
const assets = require('../chain/assets');

function handleAssetRequest(ledger, message) {
  if (!message || typeof message.method !== 'string') {
    return { jsonrpc: '2.0', id: null, error: { message: 'method required' } };
  }
  const id = Object.prototype.hasOwnProperty.call(message, 'id') ? message.id : 1;
  if (message.method === 'getAssetsByOwner') {
    const owner = message.params && message.params.owner;
    return { jsonrpc: '2.0', id, result: assets.getAssetsByOwner(ledger, owner) };
  }
  if (message.method === 'parseTransfer') {
    const params = message.params || {};
    const tx = params.transaction || params;
    return { jsonrpc: '2.0', id, result: assets.parseTransfer(tx) };
  }
  return { jsonrpc: '2.0', id, error: { message: 'unknown method' } };
}

function startAssetApi(ledger, port = 0) {
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(405, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'POST' } }));
      return;
    }
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      let message;
      try { message = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
      catch {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'parse error' } }));
        return;
      }
      const body = handleAssetRequest(ledger, message);
      const status = body.error ? 400 : 200;
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const address = server.address();
      resolve({
        server,
        url: 'http://127.0.0.1:' + address.port,
        close() {
          return new Promise(done => server.close(() => done()));
        },
      });
    });
  });
}

module.exports = {
  createLedger: assets.createLedger,
  registerMint: assets.registerMint,
  setBalance: assets.setBalance,
  getAssetsByOwner: assets.getAssetsByOwner,
  parseTransfer: assets.parseTransfer,
  handleAssetRequest,
  startAssetApi,
};
