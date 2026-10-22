// clawd API docs (api.) + read-only remote MCP server (mcp.). No secrets, no faucet bypass.
const http = require('http');
const { describeAccount, PROGRAMS } = require('./lib/read');
const PORT = +process.env.PORT || 8080;
const RPC = process.env.VALIDATOR_RPC || 'https://rpc.clawdchain.trade';
const SITE = process.env.SITE_URL || 'https://clawdchain.trade';
const FAUCET = process.env.FAUCET_URL || 'https://faucet.clawdchain.trade';
const PUBRPC = process.env.PUBLIC_RPC || 'https://rpc.clawdchain.trade';
const MCPURL = process.env.MCP_URL || 'https://mcp.clawdchain.trade/mcp';
const PAYURL = process.env.FACILITATOR_URL || 'https://payments.clawdchain.trade';
const PAYINT = process.env.PAYMENTS_INTERNAL || PAYURL;
const MINTURL = process.env.MINT_URL || 'https://mint.clawdchain.trade';
const EXPLORER = process.env.EXPLORER_URL || 'https://explorer.clawdchain.trade';
const SOURCE = 'https://github.com/Solizardking/clawd-chain';
async function registryRead(route, args = {}) {
  const q = new URLSearchParams();
  for (const k of ['q', 'network', 'limit', 'offset']) if (args[k] !== undefined) q.set(k, String(args[k]));
  const r = await fetch(`${PAYINT}${route}?${q}`, { signal: AbortSignal.timeout(5000) });
  if (!r.ok) throw new Error('registry unavailable: ' + r.status);
  return r.json();
}
const REGQ = { q: { type: 'string' }, network: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 100 }, offset: { type: 'integer', minimum: 0 } };
const LAM = 1e9, VOTE = 'Vote111111111111111111111111111111111111111';
const cache = new Map(), hits = new Map();
setInterval(() => { hits.clear(); const n = Date.now(); for (const [k, v] of cache) if (n > v.exp) cache.delete(k); }, 10000);
async function rpc(method, params = [], ttl = 2000) {
  const key = method + JSON.stringify(params), c = cache.get(key);
  if (c && Date.now() < c.exp) return c.v;
  const j = await (await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json();
  if (j.error) throw new Error(j.error.message);
  cache.set(key, { v: j.result, exp: Date.now() + ttl }); return j.result;
}
const isAddr = s => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s || ''), isSig = s => /^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(s || '');
const S = (props, req = []) => ({ type: 'object', properties: props, required: req, additionalProperties: false });
const TOOLS = {
  get_slot: { d: 'Current clawd slot (confirmed).', s: S({}), f: async () => ({ slot: await rpc('getSlot', [{ commitment: 'confirmed' }], 1000) }) },
  network_stats: { d: 'Slot, epoch, block height, tx count, TPS, supply, version, genesis hash.', s: S({}), f: async () => {
    const [e, p, sup, v, g] = await Promise.all([rpc('getEpochInfo'), rpc('getRecentPerformanceSamples', [5], 10000), rpc('getSupply', [{ excludeNonCirculatingAccountsList: true }], 30000), rpc('getVersion', [], 60000), rpc('getGenesisHash', [], 600000)]);
    const tps = p.reduce((a, s) => a + s.numTransactions, 0) / Math.max(1, p.reduce((a, s) => a + s.samplePeriodSecs, 0));
    return { slot: e.absoluteSlot, epoch: e.epoch, blockHeight: e.blockHeight, transactionCount: e.transactionCount, tps: +tps.toFixed(2), supplyCLAWD: sup.value.total / LAM, version: v['solana-core'], genesisHash: g, rpc: PUBRPC }; } },
  get_balance: { d: 'CLAWD balance of an address.', s: S({ address: { type: 'string' } }, ['address']), f: async ({ address }) => { if (!isAddr(address)) throw new Error('invalid address'); const b = await rpc('getBalance', [address]); return { address, lamports: b.value, clawd: b.value / LAM }; } },
  get_account: { d: 'Account info: balance, owner, executable, data size, recent signatures.', s: S({ address: { type: 'string' } }, ['address']), f: async ({ address }) => {
    if (!isAddr(address)) throw new Error('invalid address');
    const [i, sigs] = await Promise.all([rpc('getAccountInfo', [address, { encoding: 'base64' }]), rpc('getSignaturesForAddress', [address, { limit: 10 }])]); const v = i.value;
    return { address, exists: !!v, clawd: v ? v.lamports / LAM : 0, owner: v?.owner, executable: v?.executable, dataSize: v ? Buffer.from(v.data[0], 'base64').length : 0, recentSignatures: sigs.map(s => ({ signature: s.signature, slot: s.slot, err: s.err })), explorer: `${SITE}/address/${address}` }; } },
  get_transaction: { d: 'Transaction by signature: status, fee, instructions, logs, balance changes.', s: S({ signature: { type: 'string' } }, ['signature']), f: async ({ signature }) => {
    if (!isSig(signature)) throw new Error('invalid signature');
    const t = await rpc('getTransaction', [signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }], 600000); if (!t) return { found: false };
    const keys = t.transaction.message.accountKeys.map(k => k.pubkey || k), m = t.meta;
    return { found: true, slot: t.slot, blockTime: t.blockTime, success: !m.err, err: m.err, feeCLAWD: m.fee / LAM, instructions: t.transaction.message.instructions.map(x => ({ programId: x.programId, program: x.program, type: x.parsed?.type, info: x.parsed?.info })),
      balanceChanges: keys.map((k, i) => ({ account: k, changeCLAWD: (m.postBalances[i] - m.preBalances[i]) / LAM })).filter(x => x.changeCLAWD), logs: m.logMessages, explorer: `${SITE}/tx/${signature}` }; } },
  get_block: { d: 'Block by slot: hash, parent, time, tx counts, non-vote signatures.', s: S({ slot: { type: 'integer', minimum: 0 } }, ['slot']), f: async ({ slot }) => {
    const b = await rpc('getBlock', [slot, { maxSupportedTransactionVersion: 0, rewards: false, transactionDetails: 'full', encoding: 'json', commitment: 'confirmed' }], 600000); if (!b) return { found: false };
    const user = b.transactions.filter(t => !t.transaction.message.accountKeys.includes(VOTE));
    return { found: true, slot, blockhash: b.blockhash, parentSlot: b.parentSlot, blockHeight: b.blockHeight, blockTime: b.blockTime, txCount: b.transactions.length, userTxs: user.map(t => t.transaction.signatures[0]), explorer: `${SITE}/block/${slot}` }; } },
  recent_blocks: { d: 'Latest confirmed blocks (up to 10).', s: S({ limit: { type: 'integer', minimum: 1, maximum: 10 } }), f: async ({ limit = 5 } = {}) => {
    const slot = await rpc('getSlot', [{ commitment: 'confirmed' }], 1000); const slots = await rpc('getBlocks', [Math.max(0, slot - 40), slot, { commitment: 'confirmed' }], 1000);
    const out = []; for (const s of slots.slice(-Math.min(10, limit)).reverse()) out.push(await TOOLS.get_block.f({ slot: s })); return out; } },
  search: { d: 'Classify and look up a query: slot number, tx signature or address.', s: S({ query: { type: 'string' } }, ['query']), f: async ({ query }) => {
    const q = String(query).trim(); if (/^\d+$/.test(q)) return { kind: 'block', result: await TOOLS.get_block.f({ slot: +q }) };
    if (isSig(q)) return { kind: 'transaction', result: await TOOLS.get_transaction.f({ signature: q }) }; if (isAddr(q)) return { kind: 'account', result: await TOOLS.get_account.f({ address: q }) };
    return { kind: 'unknown' }; } },
  faucet_info: { d: 'How the clawd faucet works (limits, proof of work, endpoints). Informational only; does not request funds.', s: S({}), f: async () => {
    let bits = 20; try { bits = (await (await fetch(FAUCET + '/challenge')).json()).bits; } catch {}
    return { url: FAUCET, amountPerWalletPer12h: 69, ipCapPer12h: 138, windowHours: 12, powBits: bits, flow: ['GET /challenge -> {challenge,bits}', 'find nonce so sha256(challenge+":"+nonce) has >= bits leading zero bits (in your browser)', 'POST /airdrop {address,challenge,nonce}'], note: 'Use the faucet web page; this MCP server will not solve PoW or request airdrops.' }; } },
  get_nft: { d: 'Read a Core NFT account: name, metadata URI, and owner. Does not mint, update, transfer, or burn.', s: S({ address: { type: 'string' } }, ['address']), f: async ({ address }) => assetRead(address, 'nft') },
  get_token: { d: 'Read a fungible token mint (name, symbol, supply) or a token account amount. Does not create or transfer tokens.', s: S({ address: { type: 'string' } }, ['address']), f: async ({ address }) => assetRead(address, 'token') },
  get_agent: { d: 'Read an agent identity account: asset address and bound token mint. Does not register, delegate, revoke, or bind.', s: S({ address: { type: 'string' } }, ['address']), f: async ({ address }) => assetRead(address, 'agent') },
  payment_info: { d: 'x402 and MPP payment schemes on network clawd. Informational only; does not sign, verify, or settle a transfer.', s: S({}), f: async () => ({
    network: 'clawd', asset: 'CLAWD', schemes: ['exact', 'x402', 'mpp'],
    facilitator: PAYURL, page: PAYURL, registry: PAYURL + '/registry', discovery: PAYURL + '/discovery/resources',
    routes: ['GET /supported', 'POST /verify', 'POST /settle', 'GET /resource'],
    feePayer: 'facilitator',
    note: 'The client signs the CLAWD transfer. The facilitator pays the network fee and submits that authorized transaction. This tool does not sign, settle, or move funds.',
    programs: PROGRAMS }) },
  list_x402_resources: { d: 'Search the public registry of x402-paid tools and resources (x402 discovery format). Read-only; does not pay or call them.', s: { type: 'object', properties: REGQ, required: [], additionalProperties: false }, f: async (a = {}) => registryRead('/discovery/resources', a) },
  list_x402_facilitators: { d: 'Search the public registry of x402 facilitator endpoints. Read-only.', s: { type: 'object', properties: REGQ, required: [], additionalProperties: false }, f: async (a = {}) => registryRead('/registry/facilitators', a) },
};
async function assetRead(address, expected) {
  if (!isAddr(address)) throw new Error('invalid address');
  const info = await rpc('getAccountInfo', [address, { encoding: 'base64' }]);
  const row = describeAccount(address, info);
  if (!row.exists) return row;
  const ok = expected === 'token' ? row.kind === 'token' || row.kind === 'token-account' : row.kind === expected;
  return ok ? row : { ...row, match: false, expected };
}
// ---- MCP (streamable HTTP, stateless JSON responses) ----
async function mcp(msg) {
  const { id, method, params } = msg, ok = result => ({ jsonrpc: '2.0', id, result }), er = (code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });
  if (method === 'initialize') return ok({ protocolVersion: params?.protocolVersion || '2025-06-18', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'clawd-chain', version: '1.0.0' }, instructions: 'Read-only tools for the clawd SVM chain.' });
  if (method === 'ping') return ok({});
  if (method === 'tools/list') return ok({ tools: Object.entries(TOOLS).map(([name, t]) => ({ name, description: t.d, inputSchema: t.s, annotations: { readOnlyHint: true, openWorldHint: true } })) });
  if (method === 'tools/call') { const t = TOOLS[params?.name]; if (!t) return er(-32602, 'unknown tool');
    try { const r = await t.f(params.arguments || {}); return ok({ content: [{ type: 'text', text: JSON.stringify(r, null, 2) }], structuredContent: Array.isArray(r) ? { items: r } : r }); }
    catch (e) { return ok({ content: [{ type: 'text', text: 'error: ' + e.message }], isError: true }); } }
  if (method?.startsWith('notifications/')) return null;
  return er(-32601, 'method not found');
}
// ---- OpenAPI ----
const RPC_METHODS = ['getSlot','getEpochInfo','getRecentPerformanceSamples','getBlock','getBlocks','getBlockTime','getTransaction','getAccountInfo','getBalance','getSignaturesForAddress','getSupply','getVersion','getBlockHeight','getTransactionCount','getHealth','getGenesisHash','getClusterNodes','getSignatureStatuses','getLatestBlockhash','sendTransaction','simulateTransaction','getMinimumBalanceForRentExemption','getTokenAccountsByOwner','getPriorityFeeEstimate'];
const INTRO = `**Clawd Chain** is a Solana-compatible (SVM) test chain running **Agave 2.2.20**, with **CLAWD** as its native token. It is test-grade only: **CLAWD has no monetary value**.

It runs on a dedicated **Hetzner server in Helsinki** (12 cores, 24 GB RAM, about 450 GB disk) behind Caddy with automatic HTTPS.

## Live services
| Service | URL |
|---|---|
| Website | [clawdchain.trade](${SITE}) |
| Explorer | [explorer.clawdchain.trade](${EXPLORER}) |
| RPC gateway (HTTP + WebSocket) | [rpc.clawdchain.trade](${PUBRPC}) |
| Faucet | [faucet.clawdchain.trade](${FAUCET}) |
| API docs (this page) | [api.clawdchain.trade](https://api.clawdchain.trade) · [openapi.json](https://api.clawdchain.trade/openapi.json) · [llms.txt](https://api.clawdchain.trade/llms.txt) |
| MCP server (read-only, streamable HTTP) | [mcp.clawdchain.trade/mcp](${MCPURL}) |
| x402 payments facilitator ✅ live | [payments.clawdchain.trade](${PAYURL}) |
| Mint page ✅ live | [mint.clawdchain.trade](${MINTURL}) |

## Features
- **Metaplex Core NFTs**: Core, Candy Machine and Candy Guard are preloaded at genesis. Mint from the [mint page](${MINTURL}).
- **Token-2022** and SPL Token are built in.
- **Agents**: on-chain agent identity reads.
- **x402 payments**: schemes \`exact\`, \`x402\` and \`mpp\` (split) on network \`clawd\`. The facilitator pays the network fee.
- **Open x402 registry**: anyone can list an x402-paid tool or their own facilitator at [payments.clawdchain.trade/#registry](${PAYURL}/#registry). Discovery is at [/discovery/resources](${PAYURL}/discovery/resources), and the MCP tools \`list_x402_resources\` and \`list_x402_facilitators\` read it.

## Public RPC limits
About 40 requests per 10 s per IP, with a maximum batch of 10. \`getProgramAccounts\`, \`getLargestAccounts\` and \`requestAirdrop\` are disabled on the public RPC. Use the [faucet](${FAUCET}) to get CLAWD.

## Run it yourself
\`\`\`bash
git clone ${SOURCE} && cd clawd-chain
cp deploy/hetzner/env.example deploy/hetzner/.env   # set FAUCET_KEY and POW_SECRET
bash deploy/hetzner/up.sh                           # validator, faucet, explorer, api, payments
npm test
\`\`\`

Source: [github.com/Solizardking/clawd-chain](${SOURCE})`;
const spec = () => ({ openapi: '3.1.0', info: { title: 'clawd chain API', version: '1.0.0', description: INTRO + '\n\n## Program ids\n' + Object.entries(PROGRAMS).map(([name, id]) => `- ${name}: \`${id}\``).join('\n') },
  servers: [{ url: SITE }],
  paths: {
    '/rpc': { servers: [{ url: PUBRPC, description: 'Solana JSON-RPC (POST to root) and WebSocket (wss://)' }], post: { summary: 'Solana JSON-RPC 2.0', description: 'POST to the server root. Standard Solana methods, e.g. ' + RPC_METHODS.join(', ') + '.', operationId: 'jsonRpc',
      requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['jsonrpc','id','method'], properties: { jsonrpc: { const: '2.0' }, id: {}, method: { type: 'string', enum: RPC_METHODS }, params: { type: 'array' } } }, example: { jsonrpc: '2.0', id: 1, method: 'getSlot' } } } },
      responses: { 200: { description: 'JSON-RPC response' }, 429: { description: 'rate limited' }, 403: { description: 'method disabled' } } } },
    '/api/rpc': { post: { summary: 'Explorer data relay (cached, read-only)', description: 'Cached relay used by the explorer. Body {method, params}. Allowed: getSlot, getEpochInfo, getRecentPerformanceSamples, getBlock, getBlocks, getBlockTime, getTransaction, getAccountInfo, getBalance, getSignaturesForAddress, getSupply, getVersion, getBlockHeight, getTransactionCount, getHealth, getGenesisHash, getClusterNodes, getSignatureStatuses. 60 req/10s per IP.', operationId: 'explorerRelay',
      requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { method: { type: 'string' }, params: { type: 'array' } } }, example: { method: 'getEpochInfo' } } } }, responses: { 200: { description: 'JSON-RPC response' } } } },
    '/explorer': { get: { summary: 'Explorer home (HTML)', responses: { 200: { description: 'HTML' } } } },
    '/tx/{signature}': { get: { summary: 'Transaction page (HTML)', parameters: [{ name: 'signature', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: { description: 'HTML' } } } },
    '/address/{address}': { get: { summary: 'Account page (HTML)', parameters: [{ name: 'address', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: { description: 'HTML' } } } },
    '/block/{slot}': { get: { summary: 'Block page (HTML)', parameters: [{ name: 'slot', in: 'path', required: true, schema: { type: 'integer' } }], responses: { 200: { description: 'HTML' } } } },
    '/challenge': { servers: [{ url: FAUCET }], get: { summary: 'Faucet proof-of-work challenge', operationId: 'faucetChallenge', responses: { 200: { description: 'challenge', content: { 'application/json': { example: { challenge: '1792015146000.ab12cd34ef56ab78.<hmac>', bits: 20 } } } } } } },
    '/airdrop': { servers: [{ url: FAUCET }], post: { summary: 'Faucet airdrop (69 CLAWD/wallet/12h, 138/IP/12h)', description: 'Solve the PoW first: find nonce with sha256(challenge+":"+nonce) having >= bits leading zero bits. Challenges expire in 10 minutes and are single-use.', operationId: 'faucetAirdrop',
      requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['address','challenge','nonce'], properties: { address: { type: 'string' }, challenge: { type: 'string' }, nonce: { type: 'integer' } } } } } },
      responses: { 200: { description: '{signature, amount}' }, 400: { description: 'invalid address / challenge / PoW' }, 429: { description: 'wallet or IP limit' } } } },
    '/nft/{address}': { get: { summary: 'Read a Core NFT', description: 'Account read of a Metaplex Core NFT: name, metadata URI, and owner. Program ' + PROGRAMS.core + '. Does not mint or transfer.', operationId: 'getNft', parameters: [{ name: 'address', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: { description: 'NFT account or exists:false' }, 400: { description: 'invalid address' } } } },
    '/token/{address}': { get: { summary: 'Read a fungible token', description: 'Account read of an SPL Token or Token-2022 mint (name, symbol, supply) or token account. Programs ' + PROGRAMS.token + ' and ' + PROGRAMS.token2022 + '. Does not create or transfer.', operationId: 'getToken', parameters: [{ name: 'address', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: { description: 'token account or exists:false' }, 400: { description: 'invalid address' } } } },
    '/agent/{address}': { get: { summary: 'Read an agent identity', description: 'Account read of an agent identity: asset address and bound token mint. Program ' + PROGRAMS.agentIdentity + '. Does not register, delegate, or bind.', operationId: 'getAgent', parameters: [{ name: 'address', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: { description: 'agent account or exists:false' }, 400: { description: 'invalid address' } } } },
    '/x402': { get: { summary: 'x402 payment schemes', description: 'Informational x402 and MPP payment schemes on network clawd. The facilitator pays the network fee. This route does not sign or settle.', operationId: 'x402Payments', responses: { 200: { description: 'payment info' } } } },
    '/discovery/resources': { servers: [{ url: PAYURL }], get: { summary: 'x402 discovery: registered paid resources', operationId: 'discoveryResources', parameters: ['q', 'network', 'limit', 'offset'].map(name => ({ name, in: 'query', schema: { type: 'string' } })), responses: { 200: { description: '{x402Version, items, pagination}' } } } },
    '/registry/resources': { servers: [{ url: PAYURL }], get: { summary: 'List registered x402 resources', operationId: 'listRegistryResources', responses: { 200: { description: '{total, items}' } } }, post: { summary: 'Register an x402-paid tool or resource', operationId: 'registerResource', description: 'Public, 5 registrations per hour per IP. Listing only; does not move funds.', requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['name', 'url', 'price', 'payTo'], properties: { name: { type: 'string' }, url: { type: 'string', format: 'uri' }, description: { type: 'string' }, network: { type: 'string', default: 'clawd' }, schemes: { type: 'array', items: { type: 'string', enum: ['exact', 'x402', 'mpp'] } }, price: { type: 'string', description: 'base units (lamports)' }, asset: { type: 'string', default: 'CLAWD' }, payTo: { type: 'string' }, method: { type: 'string', enum: ['GET', 'POST'] }, facilitator: { type: 'string', format: 'uri' }, tags: { type: 'array', items: { type: 'string' } }, contact: { type: 'string' } } } } } }, responses: { 201: { description: 'entry' }, 400: { description: 'validation errors' }, 409: { description: 'duplicate url' }, 429: { description: 'rate limited' } } } },
    '/registry/facilitators': { servers: [{ url: PAYURL }], get: { summary: 'List registered x402 facilitators', operationId: 'listRegistryFacilitators', responses: { 200: { description: '{total, items}' } } }, post: { summary: 'Register an x402 facilitator endpoint', operationId: 'registerFacilitator', requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['name', 'url'], properties: { name: { type: 'string' }, url: { type: 'string', format: 'uri' }, description: { type: 'string' }, network: { type: 'string' }, schemes: { type: 'array', items: { type: 'string' } }, feePayer: { type: 'string' } } } } } }, responses: { 201: { description: 'entry' }, 400: { description: 'validation errors' }, 429: { description: 'rate limited' } } } },
    '/payments': { get: { summary: 'Clawd x402 payment facilitator info', description: 'Same payload as /x402. Schemes exact, x402, and mpp. Does not move funds.', operationId: 'paymentsInfo', responses: { 200: { description: 'payment info' } } } },
  } });
const DOCS = `<!doctype html><html><head><meta charset="utf-8"><title>clawd chain API</title><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="${SITE}/logo.svg"><style>body{margin:0;background:#07060d;color:#e9e6ff;font:15px/1.5 ui-sans-serif,system-ui,sans-serif}nav{display:flex;align-items:center;gap:14px 18px;flex-wrap:wrap;padding:12px 22px;background:#07060d;border-bottom:1px solid #2a2346}nav .brand{display:flex;align-items:center;gap:8px;margin-right:auto;color:#e9e6ff;font-weight:800;font-size:18px;text-decoration:none}nav a{color:#8c86b3;font-weight:600;text-decoration:none}nav a.on,nav a:hover{color:#e9e6ff}nav a.hot{background:linear-gradient(90deg,#ff3b5c,#ff8a3d);color:#0b0710;border-radius:12px;padding:7px 12px}nav a.hot:hover{color:#0b0710}#api-reference{display:block;height:calc(100vh - 52px)}</style></head><body>
<nav><a class="brand" href="${SITE}/"><img src="${SITE}/logo.svg" width="28" height="28" alt=""> clawd</a><a href="${SITE}/">Home</a><a href="${SITE}/explorer">Explorer</a><a class="hot" href="${EXPLORER}/launchpad">Launchpad</a><a href="${SITE}/readme">Wallet</a><a href="${FAUCET}">Faucet</a><a href="${PAYURL}">Payments</a><a href="${MINTURL}">Mint</a><a class="on" href="https://api.clawdchain.trade">API</a><a href="https://github.com/Solizardking/clawd-chain">GitHub</a></nav>
<script id="api-reference" data-url="/openapi.json"></script><script>document.getElementById('api-reference').dataset.configuration=JSON.stringify({theme:'purple',darkMode:true,metaData:{title:'clawd chain API'}})</script>
<script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference"></script></body></html>`;
const LLMS = () => `# clawd chain\n\n> Public Solana-compatible (SVM) test chain. Native coin CLAWD (9 decimals, no monetary value).\n\n- Site: ${SITE}\n- Explorer: ${SITE}/explorer\n- RPC (JSON-RPC + WebSocket): ${PUBRPC}\n- Faucet: ${FAUCET} (69 CLAWD per wallet every 12h, browser proof of work)\n- API docs: https://api.clawdchain.trade (OpenAPI: https://api.clawdchain.trade/openapi.json)\n- MCP (streamable HTTP, read-only): ${MCPURL}\n- Explorer (subdomain): ${EXPLORER}\n- x402 payments facilitator: ${PAYURL} (schemes exact, x402, mpp; network clawd)\n- x402 registry: ${PAYURL}/registry (POST /registry/resources, POST /registry/facilitators; discovery ${PAYURL}/discovery/resources)\n- Mint page: ${MINTURL}\n- Far demo: ${SITE}/far (in-memory named accounts, scoped keys, two shards, net-zero intents, CLAWD credits for model work; FIPS 204 ML-DSA-65; does not spend Agave CLAWD)\n- Source: ${SOURCE}\n\n## MCP tools\n${Object.entries(TOOLS).map(([n, t]) => `- ${n}: ${t.d}`).join('\n')}\n\n## Programs\n${Object.entries(PROGRAMS).map(([name, id]) => `- ${name}: ${id}`).join('\n')}\n\n## Notes\n- Public RPC is rate limited (~40 req/10s per IP); getProgramAccounts, getLargestAccounts, requestAirdrop disabled.\n- Core NFTs, fungible tokens (Token-2022), agents, and x402 payments are read here. MCP does not solve faucet proof of work, airdrop, or sign transfers.\n- Metaplex Core, Candy Machine, Candy Guard, Agent Identity, Agent Tools, Genesis, and Token Metadata load with the validator. SPL Token and Token-2022 are built in.\n`;
const WELL = () => ({ name: 'clawd-chain', description: 'Read-only tools for the clawd SVM chain', version: '1.0.0', transport: { type: 'streamable-http', url: MCPURL }, endpoints: { mcp: MCPURL }, tools: Object.keys(TOOLS), docs: 'https://api.clawdchain.trade', llms: 'https://api.clawdchain.trade/llms.txt' });
const ipOf = r => (r.headers['x-forwarded-for'] || r.socket.remoteAddress || '').split(',')[0].trim();
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type,mcp-session-id,mcp-protocol-version,accept,authorization', 'access-control-allow-methods': 'GET,POST,DELETE,OPTIONS', 'access-control-expose-headers': 'mcp-session-id' };
const send = (res, code, body, type = 'application/json') => { res.writeHead(code, { ...CORS, 'content-type': type }); res.end(typeof body === 'string' ? body : JSON.stringify(body, null, 2)); };
http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x'), p = u.pathname;
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }
  if (p === '/health') return send(res, 200, 'ok', 'text/plain');
  if (p === '/openapi.json') return send(res, 200, spec());
  if (p === '/llms.txt') return send(res, 200, LLMS(), 'text/plain; charset=utf-8');
  if (p === '/.well-known/mcp.json' || p === '/.well-known/mcp') return send(res, 200, WELL());
  if (p === '/mcp' || p === '/mcp/') {
    if (req.method === 'GET') return send(res, 405, { error: 'use POST (streamable HTTP, stateless; no server-initiated stream)' });
    if (req.method === 'DELETE') { res.writeHead(204, CORS); return res.end(); }
    const ip = ipOf(req), n = (hits.get(ip) || 0) + 1; hits.set(ip, n);
    if (n > 30) return send(res, 429, { jsonrpc: '2.0', id: null, error: { code: -32000, message: 'rate limited: 30 requests per 10s' } });
    let b = ''; req.on('data', d => { b += d; if (b.length > 65536) req.destroy(); });
    req.on('end', async () => {
      let m; try { m = JSON.parse(b); } catch { return send(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }); }
      const batch = Array.isArray(m), list = (batch ? m : [m]).slice(0, 10), out = (await Promise.all(list.map(mcp))).filter(Boolean);
      if (!out.length) { res.writeHead(202, CORS); return res.end(); }
      const r = batch ? out : out[0];
      if ((req.headers.accept || '').includes('text/event-stream') && !(req.headers.accept || '').includes('application/json')) { res.writeHead(200, { ...CORS, 'content-type': 'text/event-stream' }); return res.end(`event: message\ndata: ${JSON.stringify(r)}\n\n`); }
      send(res, 200, r);
    });
    return;
  }
  if (req.method === 'GET' && (p === '/x402' || p === '/payments')) {
    TOOLS.payment_info.f({}).then(body => send(res, 200, body), e => send(res, 502, { error: e.message }));
    return;
  }
  if (req.method === 'GET' && (p === '/nft' || p === '/token' || p === '/agent')) {
    const program = p === '/nft' ? PROGRAMS.core : p === '/token' ? PROGRAMS.token2022 : PROGRAMS.agentIdentity;
    return send(res, 200, { kind: p.slice(1), program, lookup: `${p}/{address}`, readOnly: true });
  }
  const assetPath = p.match(/^\/(nft|token|agent)\/([^/]+)$/);
  if (req.method === 'GET' && assetPath) {
    const tool = assetPath[1] === 'nft' ? 'get_nft' : assetPath[1] === 'token' ? 'get_token' : 'get_agent';
    TOOLS[tool].f({ address: decodeURIComponent(assetPath[2]) }).then(
      body => send(res, 200, body),
      e => send(res, /invalid address/.test(e.message) ? 400 : 502, { error: e.message }),
    );
    return;
  }
  if (p === '/' || p === '/docs') { const host = (req.headers.host || ''); if (host.startsWith('mcp.')) return send(res, 200, WELL()); return send(res, 200, DOCS, 'text/html; charset=utf-8'); }
  send(res, 404, { error: 'not found' });
}).listen(PORT, '::', () => console.log('clawd api on', PORT));
