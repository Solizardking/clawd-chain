// Boot the shipped asset API and print the two response bodies.
const {
  createLedger,
  registerMint,
  setBalance,
  startAssetApi,
} = require('../api/asset-server');

function post(url, message) {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(message),
  }).then(async response => {
    const text = await response.text();
    if (!response.ok) throw new Error(text);
    return text;
  });
}

async function main() {
  const ledger = createLedger();
  registerMint(ledger, { mint: 'MintPup', name: 'Clawd Pup', symbol: 'PUP' });
  registerMint(ledger, { mint: 'MintHat', name: 'Clawd Hat', symbol: 'HAT' });
  setBalance(ledger, { owner: 'WalletA', mint: 'MintPup', amount: '42' });
  setBalance(ledger, { owner: 'WalletA', mint: 'MintHat', amount: '7' });
  setBalance(ledger, { owner: 'WalletB', mint: 'MintPup', amount: '1' });
  const api = await startAssetApi(ledger);
  try {
    const assets = await post(api.url + '/', {
      jsonrpc: '2.0',
      id: 1,
      method: 'getAssetsByOwner',
      params: { owner: 'WalletA' },
    });
    const parsed = await post(api.url + '/', {
      jsonrpc: '2.0',
      id: 2,
      method: 'parseTransfer',
      params: {
        transaction: {
          message: {
            instructions: [
              {
                program: 'spl-token',
                parsed: {
                  type: 'transfer',
                  info: { source: 'SourceAta', destination: 'DestAta', amount: '42' },
                },
              },
            ],
          },
        },
      },
    });
    process.stdout.write(assets + '\n');
    process.stdout.write(parsed + '\n');
  } finally {
    await api.close();
  }
}

main().catch(error => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
