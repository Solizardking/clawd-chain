# clawd chain

A public, standalone SVM (Solana-compatible) chain for the clawd ecosystem. Native token label: **CLAWD**.
It runs a single Agave `solana-test-validator` (v2.2.20) behind a small Node gateway (`proxy.js`) that serves HTTP RPC and WebSocket on one HTTPS domain.
Metaplex Core, Core Candy Machine and Core Candy Guard are preloaded (cloned from mainnet at genesis).

**Mission: Educate · Onboard · Entertain.** A real chain, with real Solana tooling, that anyone can learn on — built and operated by an AI agent.

> Test/dev-grade network: one validator, no bridge, tokens have no monetary value. State may be reset.

## The story: forking Solana with SVMKit

Solana's execution layer — the Solana Virtual Machine — is not welded to Solana the network. [SVMKit](https://github.com/abklabs/svmkit), by ABK Labs, is the operational toolchain built on that fact: a suite for building, maintaining, and operating SVM blockchains, with genesis configuration, fast cluster deployment, network management, and RPC + wallet integration. Its ethos is the whole point: **fork, customize, and contribute.**

Clawd Chain is that playbook, run end to end by an agent:

1. **Start with Agave** — the same client family that runs mainnet, as a standalone `solana-test-validator`.
2. **Write a genesis with a name on it** — native token labeled CLAWD, and the Metaplex stack cloned in from mainnet so NFTs work from block zero.
3. **One gateway in front** — `proxy.js` puts HTTP RPC + WebSocket on a single HTTPS domain, with public rate limits and the heavy methods switched off.
4. **A faucet with a bouncer** — free test CLAWD behind a proof-of-work challenge, no accounts.
5. **Operate it like it matters** — supervised ledger, snapshot recovery, an explorer, an OpenAPI surface, and a read-only MCP server so other agents can read the chain natively.

**Where it runs:** production's validator runs on a dedicated **Hetzner** host. The project stays connected to **Railway** — the API service runs there, and the recipe below is the original deploy path (and still the fastest way to run your own). The chain graduated; the recipe remains.

## 🦀 Percolator — perps on clawd chain
Perpetual futures and an insurance-pool stake are live on testnet at **https://percolator.clawdchain.trade**. Program IDs, a how-to and on-chain proof: **[docs/percolator.md](docs/percolator.md)**.

## Next release
See **[RELEASE.md](RELEASE.md)** for the v-next package (Alpenglow option, Hetzner/Fly deploy configs, Percolator + price keeper services, pre-deploy checklist). Operator notes: [docs/OPERATIONS.md](docs/OPERATIONS.md).

## Endpoints
- Explorer: https://clawdchain.trade (also https://explorer.clawdchain.trade)
- RPC: `https://rpc.clawdchain.trade`
- WebSocket: `wss://rpc.clawdchain.trade`
- Faucet: **https://faucet.clawdchain.trade** (69 CLAWD per wallet per 12h, 138 per IP per 12h, proof-of-work anti-bot)
- Genesis hash: `7nu7q65M7dhJu9j6Zo1XkL4VRfMdg8544Xy62KR8TiHY`

## Public RPC limits
- ~40 requests / 10s per IP (batches count per call, max 10 per batch), 5 concurrent WebSockets per IP
- Disabled: `getProgramAccounts`, `getLargestAccounts`, `requestAirdrop` (use the faucet)

```bash
solana config set --url https://rpc.clawdchain.trade
solana cluster-version
```

## Programs from block zero

Cloned from mainnet at genesis:

| Program | ID |
|---|---|
| Metaplex Core | `CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d` |
| Core Candy Machine | `CMACYFENjoBMHzapRXyo1JZkVS6EtaDDzkjMrmQLvr4J` |
| Core Candy Guard | `CMAGAKJ67e9hRZgfC5SFTbZH8MgEmtqazKXjmkaJjWTJ` |

Also live on the chain:

| Program | ID |
|---|---|
| Token Metadata | `metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s` |
| SPL Token | `TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA` |
| Token-2022 | `TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb` |
| Wrapped SOL | `So11111111111111111111111111111111111111112` |
| Agent Identity | `1DREGFgysWYxLnRnKQnwrxnJQeSMk2HmGaC6whw2B2p` |
| Agent Tools | `TLREGni9ZEyGC3vnPZtqUh95xQ8oPqJSvNjvB7FGK8S` |
| Genesis | `GNS1S5J5AspKXgpjz6SvKL66kPaKWAhaGRhCqPRxii2B` |

## Deploy your own on Railway

This is the original recipe — how Clawd Chain itself started, and how to fork the fork.

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
  Tools: get_slot, network_stats, get_balance, get_account, get_transaction, get_block, recent_blocks, search, faucet_info, get_nft, get_token, get_agent, payment_info. The lookups are read-only; `payment_info` describes x402 payments and does not sign or settle. No tool solves the faucet PoW or requests funds.
- WebMCP: landing, explorer and faucet pages register the same read tools via `navigator.modelContext` when available.
- Discovery: https://clawdchain.trade/llms.txt and https://clawdchain.trade/.well-known/mcp.json
- Source: `api/` (Railway service clawd-api)
- **The official Clawd Chain bot** (by Grok Bot) connects to the chain directly — it was born with a Clawd Chain wallet, the RPC and the API wired in. The first blockchain with its own @bot.

## Ecosystem

- **Explorer** — https://clawdchain.trade — live chain tip, latest blocks and transactions, search by slot, signature or address.
- **Payments** — https://payments.clawdchain.trade — home page for the x402 facilitator API that settles machine payments on the chain.
- **Percolator** — https://percolator.clawdchain.trade — launch perpetual markets on Clawd Chain and trade against a house LP with test cUSD; positions can be wrapped into Token-2022 NFTs. Test environment.
- **Far demo** — https://clawdchain.trade/far — named accounts, scoped keys, two shards and net-zero intents, with FIPS 204 ML-DSA-65 signatures. In-memory on the explorer; it does not spend Agave CLAWD.

## Clawd Chain Wallet

Local-custody Chrome wallet for this chain. The seed stays on the device. Release: https://github.com/Solizardking/clawd-chain-wallet/releases/tag/v1.0.0

The animated README runs on the explorer and mounts that wallet: https://clawdchain.trade/readme

## The story on Musebook

How and why this chain was forked — the SVMKit story, live chain stats, and the quickstart — also lives at https://musebook.trade/clawd-chain
