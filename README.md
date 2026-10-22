# clawd chain

A public, standalone SVM (Solana-compatible) chain for the clawd ecosystem. Native token label: **CLAWD**.
It runs a single Agave `solana-test-validator` (v2.2.20) on Railway behind a small Node gateway (`proxy.js`) that serves HTTP RPC and WebSocket on one HTTPS domain.
Metaplex Core, Core Candy Machine, Core Candy Guard, Agent Identity, Agent Tools, Genesis, and Token Metadata are preloaded (cloned from mainnet at genesis). SPL Token and Token-2022 are built into the validator. Wrapped SOL is cloned so an agent can bind one mint.

> Test/dev-grade network: one validator, no bridge, tokens have no monetary value. State may be reset.

## Clawd Chain Wallet

The wallet lives in `extension/` (manifest v3, version 1.0.0). It keeps the seed in extension storage, reads balances from `https://rpc.clawdchain.trade`, and signs a CLAWD transfer payload on the device. That signature is not broadcast.

The animated README is a page on the explorer, not a separate site. Open `/readme` or `/wallet`. The page loads `extension/wallet.js`, shows the address and balance, and links the address to `/address/<address>`.

Load the extension unpacked from `extension/` at `chrome://extensions` (Developer mode, Load unpacked). The public release is [Solizardking/clawd-chain-wallet](https://github.com/Solizardking/clawd-chain-wallet).

## Next release
See **[RELEASE.md](RELEASE.md)** for the v-next package: Alpenglow (Agave 4.3.2) option, Hetzner/Fly deploy configs, Percolator + price keeper services, and the pre-deploy checklist.

## Endpoints
- RPC: `https://rpc.clawdchain.trade`
- WebSocket: `wss://rpc.clawdchain.trade`
- Faucet: **https://faucet.clawdchain.trade** (5 CLAWD per wallet per 24h, 10 per IP per 24h, proof-of-work anti-bot)
- Genesis hash: `7nu7q65M7dhJu9j6Zo1XkL4VRfMdg8544Xy62KR8TiHY`

## Public RPC limits
- ~40 requests / 10s per IP (batches count per call, max 10 per batch), 5 concurrent WebSockets per IP
- Disabled: `getProgramAccounts`, `getLargestAccounts`, `requestAirdrop` (use the faucet)

```bash
solana config set --url https://rpc.clawdchain.trade
solana cluster-version
```

## Preloaded programs
| Program | ID |
|---|---|
| Metaplex Core | `CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d` |
| Core Candy Machine | `CMACYFENjoBMHzapRXyo1JZkVS6EtaDDzkjMrmQLvr4J` |
| Core Candy Guard | `CMAGAKJ67e9hRZgfC5SFTbZH8MgEmtqazKXjmkaJjWTJ` |
| Agent Identity | `1DREGFgysWYxLnRnKQnwrxnJQeSMk2HmGaC6whw2B2p` |
| Agent Tools | `TLREGni9ZEyGC3vnPZtqUh95xQ8oPqJSvNjvB7FGK8S` |
| Genesis | `GNS1S5J5AspKXgpjz6SvKL66kPaKWAhaGRhCqPRxii2B` |
| Token Metadata | `metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s` |
| SPL Token | `TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA` |
| Token-2022 | `TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb` |
| Wrapped SOL | `So11111111111111111111111111111111111111112` |

## NFTs, tokens, agents, and x402 payments

`npm install` once at the repo root. Chain calls need a local validator that loaded the programs above (`start.sh` does that on first boot). Set `CLAWD_RPC` to that validator (default in the tests is `http://127.0.0.1:18899`).

```bash
npm install
CLAWD_RPC=http://127.0.0.1:8899 node --test test/nft.test.js
CLAWD_RPC=http://127.0.0.1:8899 node --test test/token.test.js
CLAWD_RPC=http://127.0.0.1:8899 node --test test/agent.test.js
CLAWD_RPC=http://127.0.0.1:8899 node --test test/facilitator.test.js
```

x402 facilitator (its own process; the validator image does not run it):

```bash
CLAWD_RPC=http://127.0.0.1:8899 node payments/server.js
```

`GET /supported` lists schemes `exact`, `x402`, and `mpp` on network `clawd`. `POST /verify` checks a client-signed CLAWD transfer and does not move funds. `POST /settle` submits that transfer; the facilitator is the network-fee payer. An unpaid `GET /resource` returns HTTP 402 and does not include `CLAWD_PROTECTED_RESOURCE`. A valid replay returns that resource. `GET /resource?scheme=mpp` pays two recipients their stated split, with a fee payer distinct from the paying wallet.

NFTs (`chain/nft.js`, Metaplex Core): `createNft`, `fetchNft`, `updateNft`, `transferNft`, `burnNft`. The name is at most 32 characters. The metadata document has `name`, `description`, and `image`; the asset stores the URI.

Fungible tokens (`chain/token.js`, Token-2022): `createFungibleToken` sets name, symbol, and supply. `transferFungible` debits the sender and credits the recipient by that amount.

Agents (`chain/agent.js`): `registerAgent` stores a registration document (name, description, and at least one service name plus endpoint) on a Core asset. `readAgent` returns that URI and a wallet address that is not the asset address. `delegateAgent` and `revokeAgent` grant and remove an executive. `bindAgentToken` binds one mint; a second bind is rejected.

## Deploy your own on Railway
```bash
npm i -g @railway/cli && railway login
git clone https://github.com/solizardking/clawd-chain && cd clawd-chain
railway init -n clawd-chain
railway add -s clawd-validator && railway service clawd-validator
railway volume add -m /data      # ledger persists here
railway up --detach
railway domain                   # public HTTPS RPC + WSS

# faucet
railway add -s clawd-faucet
K=$(openssl rand -hex 24)
railway variables -s clawd-validator --set "FAUCET_KEY=$K"
railway variables -s clawd-faucet --set "FAUCET_KEY=$K" --set "POW_SECRET=$(openssl rand -hex 32)" \
  --set "VALIDATOR_RPC=http://clawd-validator.railway.internal:8080"
railway up faucet --path-as-root --detach -s clawd-faucet
railway domain -s clawd-faucet
```
The faucet reaches the validator over Railway's private network; `FAUCET_KEY` lets it bypass the public gateway limits. Never commit it.

Set `SUPERMEMORY_API_KEY` on clawd-validator to turn on the chain brain (`brain/`). It reads confirmed blocks from `127.0.0.1:8899` and stores each transaction (status, fee, signers, programs, CLAWD balance changes, and SPL Token / Token-2022 balance changes) plus a supply snapshot every 100 slots in the Supermemory namespace `clawd-chain`. `GET /health` and `POST /search` listen on `BRAIN_PORT` (default 8091) on the validator network. Leave the key unset to boot without it. The faucet is a separate service: a brain crash does not stop the validator, and it does not change the Pinch button, the proof of work, or the 24h CLAWD caps. Never commit the key.
Recommended: Railway Pro, ~4 vCPU / 8 GB RAM. Only `$PORT` (the gateway) is public; the faucet (9900) and gossip/TPU stay private.
To reset the chain, set the `LEDGER_RESET_TOKEN` variable on clawd-validator to a new value and redeploy (wipes the ledger once). `LEDGER_LIMIT` (default 250000 shreds) caps ledger size.

## Deploy on Hetzner

Host `ubuntu-24gb-hel1-1` in Helsinki DC Park 1. Public IPv4 `95.216.154.157`. IPv6 network `2a01:4f9:c015:fe8f::/64` (a prefix, not a bind address). The host address on that network is `2a01:4f9:c015:fe8f::1`. The stack definition is `deploy/hetzner/compose.json`.

The validator image publishes the gateway on port 8080 and keeps the ledger in the named volume `clawd-ledger` mounted at `/data` (`/data/ledger` inside the container). Faucet (`9900`), explorer (`9901`), and API (`9902`) set `VALIDATOR_RPC` to `http://validator:8080`, the gateway on that container. The x402 payments facilitator (`9903`) sets `CLAWD_RPC` to that same gateway. When those variables are unset, faucet, explorer, and the shield deploy script fall back to `http://95.216.154.157:8080`. They do not use the Railway validator URLs. Gossip and TPU stay unpublished. The gateway still rate-limits and still blocks `getProgramAccounts`, `getLargestAccounts`, and `requestAirdrop`. The faucet sends the same `FAUCET_KEY` the gateway expects, so its airdrop can pass those limits. The explorer serves the public mint page at `/mint/` and the mint script at `/mint/mint.js`.

`FAUCET_KEY` and `POW_SECRET` are read from the environment at start. Leave `SUPERMEMORY_API_KEY` unset unless you want the chain brain. When that key is set, only the validator container receives it, and the brain's search port stays off the public port list. Do not commit any of the three.

```bash
cp deploy/hetzner/env.example deploy/hetzner/.env
# set FAUCET_KEY and POW_SECRET in that file (openssl rand -hex 24 / 32)
bash deploy/hetzner/up.sh
```

`up.sh` refuses to start when either secret is missing. From `deploy/hetzner` it runs `docker compose -f compose.json up -d --build`, adding `--env-file .env` when that file exists. Check the public gateway with `getHealth` and `getSlot` against `http://95.216.154.157:8080`. Faucet health is `:9900/health`, explorer health is `:9901/health`, API health is `:9902/health`, and the facilitator is `:9903/supported`. The mint page is `http://95.216.154.157:9901/mint/`. This path does not remove the Railway deploy above.

## Files
- `Dockerfile` – Debian + Agave release binaries + Node.js
- `start.sh` – starts the validator (ledger at `/data/ledger`, `--limit-ledger-size`), the gateway, and the brain when `SUPERMEMORY_API_KEY` is set
- `proxy.js` – public gateway: rate limits, method blocklist, WS upgrades → 8900, HTTP → 8899
- `brain/` – optional Supermemory memory of transactions, token movements, and supply snapshots
- `faucet/` – faucet service (web page, `/challenge`, `POST /airdrop`)

Inspired by [abklabs/svmkit](https://github.com/abklabs/svmkit).

## API, MCP and agents

- API docs (OpenAPI + interactive): https://api.clawdchain.trade (spec at `/openapi.json`)
- Remote MCP server (streamable HTTP, read-only, 30 req/10s per IP): https://mcp.clawdchain.trade/mcp
  Tools: get_slot, network_stats, get_balance, get_account, get_transaction, get_block, recent_blocks, search, faucet_info, get_nft, get_token, get_agent, payment_info. Asset tools are account reads. payment_info describes the x402 facilitator and does not sign or settle. No tool solves the faucet PoW or requests funds.
- WebMCP: landing, explorer and faucet pages register the same read tools via `navigator.modelContext` when available.
- Discovery: https://clawdchain.trade/llms.txt and https://clawdchain.trade/.well-known/mcp.json
- Source: `api/` (Railway service clawd-api)
