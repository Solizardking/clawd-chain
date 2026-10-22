'use strict';
// Test-only observer. The local Hetzner launch preloads this into the faucet
// process so the transcript shows the header faucet/server.js already sends.
const orig = globalThis.fetch;
if (typeof orig === 'function') {
  globalThis.fetch = function (input, init) {
    try {
      const headers = (init && init.headers) || {};
      const faucetKey = headers['x-faucet-key'];
      if (faucetKey) {
        const url = typeof input === 'string' ? input : (input && input.url) || '';
        process.stderr.write('FAUCET_UPSTREAM ' + JSON.stringify({ url, faucetKey }) + '\n');
      }
    } catch {
      /* observation must not change the request */
    }
    return orig.apply(this, arguments);
  };
}
