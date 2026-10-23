# clawd x402: pay-per-call API on clawd chain (Faremeter)

Self-hosted [Faremeter](https://github.com/faremeter/faremeter) x402 stack for clawd chain. No third-party facilitator: our own facilitator verifies and settles on `rpc.clawdchain.trade`.

| Piece | File | Port |
|---|---|---|
| Facilitator (`/accepts`, `/verify`, `/settle`, `/supported`) | `facilitator.mjs` | 4021 |
| Gate: `GET /api/premium/chain-stats`, 0.001 CLAWD per call | `gate.mjs` | 4022 |
| End-to-end client | `e2e.mjs` | |

- Network: CAIP-2 `solana:BjbvUdJLreJzCfVEQZHi3D4QttNyp3P5` (first 32 chars of the Alpenglow genesis hash).
- Asset: CLAWD is the native token, and x402 `exact` is an SPL transfer, so payers use wrapped CLAWD (native mint `So111…112`). `e2e.mjs` wraps 0.01 CLAWD first.
- Facilitator co-signs as fee payer; fund its key with a little CLAWD.

```bash
npm i
FACILITATOR_KEYPAIR=/secure/facilitator.json npm run facilitator
X402_PAY_TO=<treasury pubkey> npm run gate
PAYER_KEYPAIR=/secure/payer.json npm run e2e    # 402, then pays, then 200 + settlement tx
```

Keys are passed as file paths and are never committed. Staging only; not wired into production `api/`.

## Tested on clawd chain, Oct 22 2026
- unpaid request: `402`
- paid request: `200`, settlement tx `3qU8aesdAfyG6SyChhFuqZP4tzhGovP2koVR92oGovbwo8WaPDLzDEvfLtnCFPqvujo6pme29n3UmpQUeN2mveeB`

## Next
- Put the gate behind the api proxy at `/api/premium/*` on a staging subdomain
- Add USDC (bridged SPL) as a second accepted asset
- Per-method RPC pricing (`getProgramAccounts`, archival)
