# clawd chain

A public, standalone SVM (Solana-compatible) chain for the clawd ecosystem. Native token label: **CLAWD**.
It runs a single Agave `solana-test-validator` (v2.2.20) on Railway behind a small Node gateway (`proxy.js`) that serves HTTP RPC and WebSocket on one HTTPS domain.
Metaplex Core, Core Candy Machine and Core Candy Guard are preloaded (cloned from mainnet at genesis).

> Test/dev-grade network: one validator, no bridge, tokens have no monetary value. State may be reset.

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
Recommended: Railway Pro, ~4 vCPU / 8 GB RAM. Only `$PORT` (the gateway) is public; the faucet (9900) and gossip/TPU stay private.
To reset the chain, set the `LEDGER_RESET_TOKEN` variable on clawd-validator to a new value and redeploy (wipes the ledger once). `LEDGER_LIMIT` (default 100000 shreds) caps ledger size. `start.sh` also supervises disk use: at `DISK_PURGE_PCT` (70%) it stops the validator, purges + compacts slots below the latest snapshot and restarts; above `DISK_HARD_PCT` (85%) it drops the blockstore and restarts from the latest snapshot (state kept). Set `LEDGER_RECOVER_TOKEN` to a new value to do that recovery once on boot.

## Files
- `Dockerfile` – Debian + Agave release binaries + Node.js
- `start.sh` – starts the validator (ledger at `/data/ledger`, `--limit-ledger-size`) and the gateway
- `proxy.js` – public gateway: rate limits, method blocklist, WS upgrades → 8900, HTTP → 8899
- `faucet/` – faucet service (web page, `/challenge`, `POST /airdrop`)

Inspired by [abklabs/svmkit](https://github.com/abklabs/svmkit).

## API, MCP and agents

- API docs (OpenAPI + interactive): https://api.clawdchain.trade (spec at `/openapi.json`)
- Remote MCP server (streamable HTTP, read-only, 30 req/10s per IP): https://mcp.clawdchain.trade/mcp
  Tools: get_slot, network_stats, get_balance, get_account, get_transaction, get_block, recent_blocks, search, faucet_info. No tool solves the faucet PoW or requests funds.
- WebMCP: landing, explorer and faucet pages register the same read tools via `navigator.modelContext` when available.
- Discovery: https://clawdchain.trade/llms.txt and https://clawdchain.trade/.well-known/mcp.json
- Source: `api/` (Railway service clawd-api)


## Clawd Chain Wallet

Local-custody Chrome wallet for this chain. The seed stays on the device. Release: https://github.com/Solizardking/clawd-chain-wallet/releases/tag/v1.0.0

The animated README runs on the explorer and mounts that wallet: https://clawdchain.trade/readme
