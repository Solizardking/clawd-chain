# clawd chain

A public, standalone SVM (Solana-compatible) chain for the clawd ecosystem. Native token label: **CLAWD**.
It runs a single Agave `solana-test-validator` (v2.2.20) on Railway, with Caddy serving HTTP RPC and WebSocket on one HTTPS domain.
Metaplex Core, Core Candy Machine and Core Candy Guard are preloaded (cloned from mainnet at genesis).

> Test/dev-grade network: one validator, no bridge, tokens have no monetary value. State may be reset.

## Endpoints
- RPC: `https://clawd-validator-production.up.railway.app`
- WebSocket: `wss://clawd-validator-production.up.railway.app`

```bash
solana config set --url https://clawd-validator-production.up.railway.app
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
```
Recommended: Railway Pro, ~4 vCPU / 8 GB RAM. Only `$PORT` (Caddy) is public; the faucet (9900) and gossip/TPU stay private.
To reset the chain, delete the ledger on the volume.

## Files
- `Dockerfile` – Debian + Agave release binaries + Caddy
- `start.sh` – starts the validator (ledger at `/data/ledger`, `--limit-ledger-size`) and Caddy
- `Caddyfile` – WebSocket upgrades → 8900, everything else → 8899

Inspired by [abklabs/svmkit](https://github.com/abklabs/svmkit).
