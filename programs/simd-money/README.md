# clawd-simd-money

Prototype of [toly's "SOL money" idea](https://x.com/toly/status/2114064055342121262) on **Clawd Chain**:

1. Stake-weighted price oracle  
2. Transaction-scoped flash credit in wrapped **cSOL** with a profit tax  
3. Collateralized mint + liquidation hooks  
4. Stake-lockup term notes (1 / 3 / 6 / 12 epochs) — see also [term markets](https://x.com/toly/status/2114064790373240943)

Full design: [`SIMD.md`](./SIMD.md).

## Deployed on Clawd Chain

| | |
|---|---|
| **Program ID** | `G5jpaNX33M5d93BNorL5MxMWbazYBoLK1YCBK4koyHE7` |
| **RPC** | `https://rpc.clawdchain.trade` |
| **Explorer** | `https://explorer.clawdchain.trade` |
| **Deploy tx** | [2H9nRV9k…](https://explorer.clawdchain.trade/tx/2H9nRV9kFRauvm6VbzZQkXf6XKXDqSpyJxxeuC63mKAE2SBai3VzvCE8vTDmCvGm1vyM4WkQKCUFMaYxvXwyjsrU) |
| **Upgrade tx (stake-backed)** | [LLZTuYbe…](https://explorer.clawdchain.trade/tx/LLZTuYbeyCrBT3rmjFLE2fCHEiNoq948TCWJ1FyWo35AcZBQn237G41x2uVQfDrjCFrqzrzGZLtozk5jTJppW7o) |
| **Clawd vote** | `6J5BtS3wGG4jsEwDLoKW9AghcT4fty1PfqNMVcMaQVBA` |

PDAs (seeds under the program id):

- `config`, `oracle`, `csol` (mint), `treasury`, `cvault`, `stakevault`
- `loan/<borrower>`, `pos/<owner>`
- **Stake-backed markets (v2):** `smarket/<tenor_idx>`, `snote_mint/<tenor_idx>`, `snote_vault/<tenor_idx>`, `samm_csol/<tenor_idx>`, `mstake/<tenor_idx>/<idx>`
- Legacy escrow markets (v1, superseded): `market/<tenor_idx>`, `note_mint/…`

## Why cSOL instead of native SOL?

Minting native lamports requires a **runtime change**. The prototype mints a PDA-controlled SPL token (`cSOL`, 9 decimals) and the SIMD specifies the future native-mint builtin. See SIMD.md §2.

## Build

```bash
# needs solana 4.x + cargo-build-sbf
cd program
cargo-build-sbf
```

Artifact: `program/target/deploy/clawd_money.so`

## Deploy / upgrade

```bash
# write buffer via JSON-RPC (TPU path is flaky on this RPC)
solana program write-buffer program/target/deploy/clawd_money.so \
  --buffer .keys/buffer.json \
  --keypair .keys/payer.json \
  --url https://rpc.clawdchain.trade \
  --use-rpc --with-compute-unit-price 5000

solana program deploy \
  --buffer .keys/buffer.json \
  --program-id .keys/program.json \
  --keypair .keys/payer.json \
  --url https://rpc.clawdchain.trade \
  --use-rpc --with-compute-unit-price 5000
```

## Run the demos

```bash
# core flash+tax + collateral mint
node scripts/demo.mjs

# stake-backed tenor markets (native stake accounts → Clawd vote)
node scripts/demo-stake.mjs
```

### Stake-backed notes (current)

`Lock` creates a PDA stake account (`mstake/<tenor>/<idx>`), initializes it with **market PDA** as stake + withdraw authority, sets stake **lockup epoch = market maturity**, delegates to the Clawd Chain vote account, and mints fungible tenor notes **1:1** with locked lamports (min ≈ 1 SOL + rent).

`Redeem` after maturity burns notes and withdraws from inactive stakes. `DeactivateStakes` is a permissionless crank once `epoch >= maturity`. Deactivation cooldown means redeem may return `cooldown` until the next epoch after deactivate.

Secondary market: CPAMM of notes ↔ cSOL per tenor. Deep 1-epoch seed keeps spot **below par** under demo flow size.

### Demo txs (stake-backed, 2026-10-24)

| Step | Explorer |
|---|---|
| Program upgrade | https://explorer.clawdchain.trade/tx/LLZTuYbeyCrBT3rmjFLE2fCHEiNoq948TCWJ1FyWo35AcZBQn237G41x2uVQfDrjCFrqzrzGZLtozk5jTJppW7o |
| Init 1e smarket | https://explorer.clawdchain.trade/tx/rj7HUhoHki1mfr6ebmhQJubRFBR8eQ3B76w28zZHa2vmg73Awj3Zup6t56vKSSuaPjmewhdNuRef4G5EdNY5TKQ |
| Lock 1.003 SOL → 1e stake | https://explorer.clawdchain.trade/tx/wvmDPcUZ63iegupkUkZKhUVvfa8tVAwDbVyBewpd6dALyjnQ5WEzd2SVHCQBwSD1vpCcat8rmmUTvj2Dez7FdGW |
| Deep seed 1e @ 0.99 | https://explorer.clawdchain.trade/tx/KqrC131HQ6T2hGgJxMD2zE5qWWd6VAJTa3qxk6zUfmDwfW3mfESgvp9UxdvWV8Zs9Uq7oxk35Wqt6hk6iUSacty |
| Sell 0.05 notes | https://explorer.clawdchain.trade/tx/5QWf2ZGL2qFsBSBC3jZkCmXfDEKbPf5MBGCtpgwYbBWskB3JmM9duc8HkNJZC66Uu9q8g9GwRYhGHfdjrSV8u3z6 |
| Buy notes | https://explorer.clawdchain.trade/tx/3kqoMDyct1Ur4iYKahQ6sQVfs39EBYgV39xK4DAMUvXVsgoBzoHSXiVPHGrcjrBKXfDrJNB6pSbvoTzPi2nc8MAD |

Example stake account (1e): `7pgd15BtUnWwnzeskEVvYTG72JXNRJfCJnS4vtJfTnFa` (Stake program, 1.003 SOL, delegated to Clawd vote).

Post-trade 1e spot ≈ **0.975 cSOL/note** (below par). Full result JSON: `demo-stake-result.json`.


## Gaps vs the full SIMD

- Native lamport mint (runtime allowlist) — not on Clawd Chain yet; cSOL stands in
- Multi-collateral registry / per-asset haircuts — single collateral in prototype
- Order book (optional) — CPAMM per tenor ships; series rollover UX and stake-account-backed notes are future work
- Multi-validator oracle weighting — chain currently has one validator; syscall `sol_get_epoch_stake` is wired for when the set grows
