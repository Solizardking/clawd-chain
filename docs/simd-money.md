# SIMD Money on Clawd Chain

Stake-weighted oracle money + stake-lockup term notes, deployed as program
`G5jpaNX33M5d93BNorL5MxMWbazYBoLK1YCBK4koyHE7` on Clawd Chain.

This doc combines the prototype README and the design SIMD.

---

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


---

# SIMD-CLAWD-MONEY: Stake-Weighted Oracle Money & Stake-Lockup Term Markets

- **Author:** Clawd Chain / 8 Bit (prototype for Clawd Chain testnet; inspired by [@toly](https://x.com/toly) 2026-10-24)
- **Status:** Draft + working prototype on Clawd Chain
- **Created:** 2026-10-24
- **Type:** Core (oracle + mint path) + Program (markets, tax, collateral)
- **Clawd Chain program:** `G5jpaNX33M5d93BNorL5MxMWbazYBoLK1YCBK4koyHE7`

## Summary

Enable **transaction-scoped minting of native SOL (CLAWD on Clawd Chain)** backed by any tokenized collateral, priced by a **validator stake-weighted oracle**, with a **protocol tax on realized profit**. Pair that with **tokenized stake lockups at fixed tenors** (1 / 3 / 6 / 12 epochs) that trade as a yield curve.

toly's framing (2026-10-24):

1. *"SIMD to make sol money. A validator stake weighted oracle can mint sol backed by any tokenized collateral to facilitate a transaction and collect a tax on any profit from these transactions."*
2. *"This plus a true market for stake lockups at different time intervals and markets for them."*

This SIMD separates what needs a **runtime / validator change** from what can ship as an **on-chain program**. The Clawd Chain prototype ships the program path today using a PDA-minted wrapped **cSOL** SPL token; native lamport minting is specified as a later runtime feature.

## Motivation

- SOL is the unit of account for fees, rent, and stake. Today, temporary SOL liquidity for atomic transactions usually means flash loans of *existing* SOL, not newly minted SOL against collateral. Minting against collateral inside a transaction expands useful SOL float without permanent dilution if credit is repaid (or collateral is posted) by end of transaction.
- A stake-weighted oracle makes price discovery an extension of consensus weight already bonded by validators, instead of a separate multisig or off-chain publisher set.
- A profit tax turns transactional minting into a protocol revenue stream (analogous to a seigniorage / flash-mint fee), fundable to burns, stake rewards, or a treasury.
- Stake lockup term markets let validators and delegators express duration preference and form an on-chain SOL yield curve — the missing second half of toly's post.

## New Terminology

| Term | Meaning |
|---|---|
| **cSOL** | Wrapped SOL/CLAWD SPL (or Token-2022) minted by the money program. Prototype stand-in for native lamports. |
| **Flash credit** | Transaction-scoped mint of cSOL/SOL that must be repaid (or converted to a collateralized position) before the transaction ends. |
| **Stake-weighted median** | Oracle aggregation: sort reporter prices, walk cumulative stake weight until ≥ 50% of reporting weight. |
| **Quorum** | Minimum fraction of *registered* stake weight that must have fresh prices before Aggregate succeeds. |
| **Haircut** | Per-collateral discount applied to oracle value when computing mintable credit. |
| **Profit tax** | `tax_bps` of `max(0, end_balance − (pre_balance + minted))` taken to the treasury on Repay. |
| **Lock note** | Fungible SPL note minted 1:1 against a native stake account delegated to the Clawd vote; matures at `lock_epoch + tenor`. |
| **Tenor** | Lock duration in epochs: `{1, 3, 6, 12}` in the prototype. |

## Detailed Design

### 1. Stake-weighted price oracle

**Recommendation for production Solana / Clawd Chain:** a **dedicated on-chain program**, not Alpenglow vote payloads.

| Approach | Pros | Cons |
|---|---|---|
| **A. Separate oracle program (chosen)** | Clear account model; works on any SVM; easy to reason about quorum / staleness; no consensus-path risk | Requires reporters to submit an extra tx (or crank) |
| **B. Piggyback on Alpenglow / Tower votes** | Zero extra bandwidth if price fits in vote extensions | Couples money to consensus; vote size / fork choice implications; harder to upgrade; Clawd Chain Alpenglow is epoch-0 but vote extension ABI is not stable enough for money |

**Reporter set.** Registered `(reporter_pubkey, vote_account)` pairs. Weight = `sol_get_epoch_stake(vote_account)` (SIMD-0133 / Agave 2.x syscall) when the vote account is live; admin-supplied weight otherwise (prototype / permissioned bootstrap).

**PostPrice.** Signer must be a registered reporter. Stores `(price, slot)`.

**Aggregate.** Anyone may crank.
1. Drop reports older than `max_age_slots`.
2. Require `sum(fresh.weight) / total_weight ≥ quorum_bps / 10_000`.
3. Stake-weighted median → `oracle.price`, `oracle.slot`.

**Price units.** Fixed-point: `price` = cSOL base units per 1 collateral base unit, scale `1e9` (so `1_000_000_000` = 1:1).

### 2. Transaction-scoped minting (flash credit) + profit tax

#### Runtime vs program

| Capability | Runtime change? | Prototype |
|---|---|---|
| Mint **native lamports** out of thin air | **Yes** — new loader/runtime CPI or builtin (`mint_lamports_checked`) gated by a program id allowlist | Not available; see below |
| Mint **cSOL** SPL via PDA mint authority | No | **Implemented** |
| Enforce repay in-same-tx | No — Instructions sysvar introspection | **Implemented** |
| Collect profit tax | No | **Implemented** |

**Native mint (future runtime).** A gated builtin:

```
mint_native_lamports(to, amount, authority_program)
burn_native_lamports(from, amount, authority_program)
```

only callable by programs on a feature-gated allowlist (the Money program). Until then, cSOL is 1:1 redeemable against a SOL vault once a separate custodian path exists; on Clawd Chain the prototype treats cSOL as the unit of account for the demo.

#### Flash credit lifecycle (program)

```
FlashMint(amount)
  - require stack_height == TRANSACTION_LEVEL (no CPI into FlashMint)
  - require a later instruction in this tx is Repay for this program
  - record loan { borrower, amount, pre_balance, active }
  - mint `amount` cSOL to borrower ATA

… arbitrary instructions (swaps, transfers, …) …

Repay
  - bal = borrower cSOL balance
  - profit = bal − (pre_balance + amount)
  - tax = profit * tax_bps / 10_000   (0 if profit ≤ 0)
  - require bal ≥ pre_balance + amount + tax
  - burn `amount`; transfer `tax` → treasury ATA
  - clear loan
```

Failed repay → whole transaction fails → mint never commits. That is the atomicity guarantee.

#### Collateralized mint (persistent)

`DepositMint(collateral, mint_amount)`:
- Pull collateral into vault.
- `max_mint = collateral * price / 1e9 * (10_000 − haircut_bps) / 10_000`.
- Require `mint_amount ≤ max_mint`; mint cSOL; book `{collateral, debt}` on a Position PDA.

`Liquidate(repay_debt)`:
- Allowed when `collateral_value < debt * liq_bps / 10_000`.
- Liquidator burns cSOL equal to `repay_debt`, receives collateral at oracle price plus `LIQ_BONUS_BPS` (5%).
- If collateral is exhausted with debt remaining → add to `config.bad_debt` (socialize later via tax revenue or haircut on new mints — policy choice; prototype only accounts it).

**Haircuts.** Per-collateral-type in production (registry). Prototype: single `haircut_bps` on Config.

### 3. Stake-lockup term markets + secondary AMM (implemented)

**Fungible tenor notes backed by real stake accounts.** `InitMarket { tenor_idx, fee_bps }` creates, per tenor ∈ {1,3,6,12} epochs (PDA namespace `smarket/*`):

- `snote_mint` PDA (SPL, 9 decimals, mint authority = market PDA)
- `snote_vault` + `samm_csol` vaults for a constant-product AMM vs cSOL
- `Market { maturity_epoch = now + TENORS[i], reserve_*, fee_bps, total_locked, vote, n_stakes }`

**Lock → native stake → mint.** `Lock { tenor_idx, lamports }` creates PDA stake account `mstake/<tenor>/<idx>`, initializes with market PDA as stake+withdraw authority and lockup epoch = maturity, delegates to the Clawd vote, and mints **1:1 note tokens**. Min ≈ 1 SOL stakeable + rent. Notes are freely transferable. Locking into a matured series is rejected.

**Redeem / cooldown.** After maturity, `DeactivateStakes` (permissionless) deactivates pool stakes. `Redeem { amount }` burns notes and withdraws from **inactive** stakes (custodian = market). If still cooling down, returns `cooldown` — retry next epoch. Early redeem/deactivate fail (demo asserts this).

**CPAMM.** `AmmSeed` adds note+cSOL liquidity at a chosen ratio (sets the initial discount). `AmmSwap { amount_in, min_out, note_for_csol }
- `DeactivateStakes { tenor_idx }` — permissionless post-maturity crank` trades with `fee_bps` taken on input:

`out = reserve_out − k / (reserve_in + amount_in * (1 − fee))`, `k = rn * rc`.

**Implied yield.** Spot `P = reserve_csol / reserve_note` (cSOL per note face). Face redeems at 1.0 SOL-equivalent.

- Simple yield to maturity: `y = 1/P − 1`
- Annualized (assumes ~182.5 epochs/year ≈ 2-day epochs): `y_ann = y * (182.5 / tenor_epochs)`

Longer tenors are seeded at deeper discounts → an upward-sloping curve. Deep 1-epoch liquidity keeps spot below par under demo flow size.

**Production extensions still open:**

1. Token-2022 metadata / transfer hooks; series rollover mints per maturity date
2. Order book alongside or instead of CPAMM
3. Auto crank bot for deactivate → withdraw across epochs; pooled stake consolidation

### 4. Instruction surface (prototype program `clawd_money`)

| Ix | Purpose |
|---|---|
| `Init` | Config, oracle, cSOL mint, treasury, collateral vault, stake vault |
| `RegisterReporter` | Admin adds reporter + weight (live vote stake preferred) |
| `PostPrice` / `Aggregate` | Oracle update |
| `FlashMint` / `Repay` | Transaction-scoped credit + profit tax |
| `DepositMint` / `Liquidate` | Persistent collateralized credit |
| `Lock` / `Redeem` | Mint/burn fungible tenor-note SPL against stake_vault |
| `InitMarket` | Per-tenor note mint + CPAMM vaults |
| `AmmSeed` / `AmmSwap` | Add liquidity / swap note ↔ cSOL |

### 5. Parameters (prototype defaults used in demo)

- `tax_bps = 1000` (10% of profit)
- `quorum_bps = 5000` (50%)
- `haircut_bps = 1000` (10%)
- `liq_bps = 9000` (liquidate under 90% raw collateralization)
- `max_age_slots = 10_000`
- Tenors = `{1, 3, 6, 12}` epochs

## Alternatives

1. **Pure flash loans of existing SOL** — no mint, no seigniorage, limited by pool depth. Rejected as not matching toly's "mint sol" framing.
2. **Pyth / Switchboard prices** — battle-tested but not stake-weighted by *this* cluster's validators. Can be a fallback collateral price source; primary design remains stake-weighted.
3. **Governance multisig mint** — slower, not transaction-scoped, political. Rejected for the flash path.
4. **Vote-attached prices (Alpenglow)** — deferred until vote extension story is stable; see table above.
5. **Always-on CDP only (Maker-style)** — useful, included as `DepositMint`, but alone it does not facilitate *intra-transaction* minting.

## Impact

- **Users:** Atomic access to SOL-priced liquidity against collateral; optional yield curve for duration.
- **Validators:** New role (and optional income) as oracle reporters; lockup markets deepen stake demand at longer tenors.
- **Protocol:** Tax revenue; bad-debt surface that must be governed.
- **Runtime:** Native lamport mint path needs a feature gate; until then cSOL works on any SVM including Clawd Chain.
- **Clawd Chain today:** Single validator → oracle weight is trivial (one reporter). Design still holds when the set expands.


## Stake-backed implementation (Clawd prototype)

Notes are **not** escrowed SOL. Each `Lock`:

1. Creates a program PDA stake account `mstake/<tenor_idx>/<n_stakes>` funded by the user (≥ ~1 SOL stakeable + rent on Clawd Chain).
2. `Initialize` with `Authorized { staker: market_pda, withdrawer: market_pda }` and `Lockup { epoch: maturity_epoch, custodian: market_pda }`.
3. `DelegateStake` to the Clawd Chain validator vote (`6J5BtS3wGG4jsEwDLoKW9AghcT4fty1PfqNMVcMaQVBA`).
4. Mints fungible tenor notes 1:1 with locked lamports to the user.

Markets use a fresh PDA namespace (`smarket`, `snote_mint`, `snote_vault`, `samm_csol`) so they coexist with any legacy escrow markets.

**Redeem path / cooldown:** After `Clock::epoch >= maturity_epoch`, anyone may call `DeactivateStakes`. Redeems burn notes and `Withdraw` from **inactive** stakes (custodian = market PDA bypasses remaining lockup). If stakes are still activating/deactivating, redeem returns `cooldown` — retry next epoch. Redeem may also attempt deactivate in the same tx for convenience; withdraw still needs inactive status.

**Secondary CPAMM:** `AmmSeed` / `AmmSwap` price notes ↔ cSOL. Seed discounts imply a yield curve; deep 1-epoch liquidity keeps spot below par under normal flow size.

**Program:** `G5jpaNX33M5d93BNorL5MxMWbazYBoLK1YCBK4koyHE7`  
**Stake-backed upgrade:** https://explorer.clawdchain.trade/tx/LLZTuYbeyCrBT3rmjFLE2fCHEiNoq948TCWJ1FyWo35AcZBQn237G41x2uVQfDrjCFrqzrzGZLtozk5jTJppW7o

### Demo yield curve (epoch 0, after sell/buy on 1e)

| Tenor (epochs) | Spot (cSOL/note) | Discount | Simple YTM | Ann. (approx) |
|---:|---:|---:|---:|---:|
| 1 | 0.975 | 2.53% | 2.59% | ~473% |
| 3 | 0.970 | 3.00% | 3.09% | ~188% |
| 6 | 0.940 | 6.00% | 6.38% | ~194% |
| 12 | 0.880 | 12.0% | 13.6% | ~207% |

(Annualization uses 182.5 epochs/year — illustrative; Clawd epoch length differs from mainnet.)


## Security Considerations

| Attack | Mitigation |
|---|---|
| **Oracle manipulation** | Stake-weighted median (not mean); quorum; `max_age_slots`; haircuts; liquidations. Cost of attack ≈ stake needed to move the median past haircut buffer. |
| **Reporter collusion** | Same as controlling stake. Require quorum of total registered weight; optional secondary sanity bound vs an external TWAP. |
| **Flash mint without repay** | Instructions-sysvar check that `Repay` appears later; stack-height check blocks CPI wrappers that could hide repayment failure; atomic tx rollback. |
| **Inflation / permanent dilution** | Flash path: mint is ephemeral if repaid. Persistent path: over-collateralization + liquidation. Native mint allowlist (future) must be feature-gated and program-id restricted. |
| **Bad debt** | Accounted on Config; production should auto-haircut new mints or tap tax revenue to refill. |
| **MEV / oracle lag** | Short `max_age_slots` on Clawd Chain (fast slots under Alpenglow); Aggregate crank incentives; optional slot-sampled prices. Searchers can mint→arb→repay within one tx — that is intended; tax captures a cut. |
| **Stake-vault insolvency** | Lock notes are fully backed 1:1 by vault lamports in the prototype; production staked notes need withdraw-authority discipline and slashing passthrough. |
| **cSOL ≠ SOL** | Prototype risk: cSOL is not native fee SOL. Documented; redemption rail is a follow-up. Do not market cSOL as SOL. |

## Backwards Compatibility

- No consensus change in the prototype path.
- Existing programs unaffected.
- Future native-mint builtin is opt-in behind a feature gate; old clients ignore it.
- Oracle and money program are new deployments. Stake-backed markets use `smarket/*` PDAs (legacy escrow `market/*` not migrated).

## Prototype status (Clawd Chain)

- Program id: `G5jpaNX33M5d93BNorL5MxMWbazYBoLK1YCBK4koyHE7`
- RPC: `https://rpc.clawdchain.trade`
- Explorer: `https://explorer.clawdchain.trade`
- Clawd vote: `6J5BtS3wGG4jsEwDLoKW9AghcT4fty1PfqNMVcMaQVBA`
- Stake-backed upgrade: https://explorer.clawdchain.trade/tx/LLZTuYbeyCrBT3rmjFLE2fCHEiNoq948TCWJ1FyWo35AcZBQn237G41x2uVQfDrjCFrqzrzGZLtozk5jTJppW7o
- Demos: `scripts/demo.mjs` (flash+tax), `scripts/demo-stake.mjs` (native stake notes + CPAMM yield curve)
- Gap vs full SIMD: native lamport mint (needs runtime); multi-collateral registry; order-book (CPAMM ships today); series rollover UX; auto deactivate/withdraw crank across epochs; redeem accounting on partial stake closes is best-effort; annualized yield assumes ~2-day epochs.

## References

- [@toly, 2026-10-24](https://x.com/toly/status/2114064055342121262) — stake-weighted oracle mint + profit tax
- [@toly, 2026-10-24](https://x.com/toly/status/2114064790373240943) — stake lockup term markets
- SIMD-0133 — `sol_get_epoch_stake` syscall (used for reporter weights)
- Clawd Chain — Agave 4.3.2, Alpenglow from epoch 0

