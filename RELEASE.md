# clawd chain — release v-next: pre-deploy checklist

Status: **prepared, not deployed.** Nothing in this branch has been pushed to Hetzner or Fly, the chain was not restarted, DNS was not touched.

## What's in this release
| Area | Change |
|---|---|
| Repo sync | GitHub `main` was far behind production. This branch brings in the tree running on Hetzner `/opt/clawd-chain-new`: `api/` (+`lib/`), `explorer/` (launchpad, readme, faucet feed, webmcp), `faucet/` (quota, PoW, feed), `payments/` (x402 facilitator), `brain/`, `chain/`, `extension/`, `mint/`, `clawd-shield-main/` (program + circuits), `scripts/`, `test/`. No `.env`, keypairs, ledgers or `*.zkey` (excluded, and `.gitignore` extended). |
| Alpenglow | `deploy/alpenglow/` — Agave **v4.3.2** `solana-test-validator --alpenglow` (Votor from slot 0, feature `A1pengvu…JhS`). Opt-in overlay `deploy/hetzner/docker-compose.alpenglow.yml` uses a **separate** ledger volume. |
| Hetzner | `deploy/hetzner/docker-compose.yml` (YAML successor to `compose.json`): validator, faucet, explorer, api, payments, **percolator-launch**, **price-keeper**. |
| Fly | `deploy/fly/*.fly.toml` + README (from the 2026-10-21 Fly Alpenglow trial; build dirs replaced by in-repo Dockerfiles). `deploy/firedancer-hetzner/` notes. |
| Percolator | Compose service builds from the **private** repo `Solizardking/clawd-percolator` via a BuildKit git context (`GIT_AUTH_TOKEN` build secret). No Percolator source is copied into this public repo. |
| Price keeper | `keeper/` — read-only, keyless. Phoenix WebSocket `allMids` for SOL/BTC, DexScreener for CLAWD (quoted per 1M CLAWD), clamps moves to 100 bps/tick, writes `prices.json` (1e6 = 1 cUSD). Unit test `test/keeper.test.js`. |
| Node | Tests need **Node 24** (ML-DSA-65 in `node:crypto`); `.nvmrc` added. |

### Why Percolator stays private (for now)
Recommendation: **keep the source private; publish IDs, docs and a verifiable build later.** Reasons: (1) not audited, and a public fork of a live-but-unaudited perps engine invites copy deployments that users mistake for ours; (2) the house/LP tooling and market-ops scripts live next to the programs; (3) the build is not yet reproducible (see below), so publishing source today would not let anyone verify the on-chain bytes anyway. Revisit when: audit (or at least a public review) done, house tooling split into its own repo, and `solana-verify` reproducible builds match on-chain hashes. Upstream credit (aeyakovenko/percolator via dcccrypto) stays in public docs either way — check the upstream license before any public release.

## 1. Build & test (run before every deploy)
```bash
nvm use 24 && npm ci && npm test                    # result on box: 89/90 pass (see "Known issues")
# programs (Solana CLI 4.3.x, rustup default stable)
(cd clawd-shield-main && cargo build-sbf)           # clawd_shield.so
# in clawd-percolator (private):
(cd programs/percolator-stake && cargo build-sbf)
(cd programs/percolator-nft   && cargo build-sbf)
(cd programs/percolator-prog  && cargo build-sbf)   # FAILS CLOSED until ../percolator matches ci/deployed-refs.env pin
# compose
cd deploy/hetzner && docker compose -f docker-compose.yml config -q
GIT_AUTH_TOKEN=… docker compose -f docker-compose.yml build
docker compose -f docker-compose.yml -f docker-compose.alpenglow.yml config -q
```
**Local Alpenglow smoke test** (no Docker needed):
```bash
solana-test-validator --alpenglow --ledger /tmp/ag --rpc-port 18899 --quiet &
solana -u http://127.0.0.1:18899 feature status A1pengvuM6JEcyNuTnMqepBKhwHE3N6PmUrdATGawhJS   # active since epoch 0
for so in clawd_shield percolator_prog percolator_stake percolator_nft; do solana -u http://127.0.0.1:18899 program deploy $so.so; done
node keeper/keeper.js   # with ONCE=1 PRICES_FILE=/tmp/p.json
```

## 2. Programs: redeploy plan (same IDs, same authorities)
| Program | ID | Upgrade authority |
|---|---|---|
| clawd_shield | `2AMyS5oLqvh2j4We5EUe9cHryd2vrCuVSdZtsZrP2PVH` | `BfnaYDoMhgCkFLZaADmqNfAXqmPLErUCjqD6VXmddFtf` |
| clawd_amm | `79Y18fL6zUDEuiBVCMYy9wsAheoGJifmJ22oCfvXecRT` | `BfnaYDoMhgCkFLZaADmqNfAXqmPLErUCjqD6VXmddFtf` |
| clawd_launch | **source/ID not located** in repo, box or server — find before a genesis reset | ? |
| Percolator wrapper | `6Grr3eyuJVME5gDbeT6g6Q3pojQGSuSDaEmHDM7QYhzx` | `D7nvng9ir7DDfyv1t6VPhezuf8n3L91b4Kf57QrgHfY6` |
| Percolator stake | `85rgQvJsqVq5gF9TPMtxmPQaoVMGK1wd6qx1FZqfXk5q` | `D7nvng9…fY6` |
| Percolator NFT | `GDaUkuhbErfBuL92oV93bWWHEVn9NF7pRNikSeq6nHLR` | `D7nvng9…fY6` |

- **Keep current chain:** `solana program deploy --program-id <ID> --upgrade-authority <auth keypair>` only for programs whose code changed. Nothing in this release requires a program upgrade.
- **New genesis:** load each program at genesis with the *same* ID and authority, no program keypairs needed:
  `solana-test-validator --upgradeable-program <ID> <file.so> <AUTHORITY_PUBKEY> …` (add to `deploy/alpenglow/start.sh` CLONE block). Use the **on-chain dumped bytes** (`solana program dump <ID> x.so` from the current chain, saved in the backup) so behaviour is identical — fresh local builds are not byte-identical to on-chain (wrapper 1,341,136 vs 1,366,881 bytes; stake/nft similar).
- clawd_amm source here is a single `lib.rs` (no Cargo workspace) and clawd_launch source is missing → use dumped bytes for both.

## 3. Genesis decision
Alpenglow is a genesis-time feature in `solana-test-validator` (v2.2 → v4.3 is not an in-place upgrade of this ledger, and the Fly trial got genesis `4sDjdGoJ…XAE`). **Alpenglow = new genesis.** Consequences:
- [ ] All programs re-created (section 2, same IDs via `--upgradeable-program`).
- [ ] Metaplex/Token Metadata/wSOL clones re-run (already in `start.sh`).
- [ ] Faucet funded at genesis (`FAUCET_PUBKEY`); same faucet keypair can be reused.
- [ ] CLAWD-side mints (test cUSD mint, any SPL mints): new addresses unless recreated with saved keypairs → update `deploy/clawd-percolator.json`, explorer, faucet, launchpad config.
- [ ] Percolator markets, insurance pools, LP mints, house LP account: re-run market bootstrap from the private repo; update `/opt/percolator-house/markets.json`.
- [ ] Explorer data / faucet quota / payments registry / launchpad history reset (or archived read-only).
- [ ] Shield pool re-init (all shielded notes are lost — announce).
- [ ] New genesis hash published in README + explorer; wallets/extension must re-point.
- [ ] Announce a reset window: all balances, NFTs, positions and stakes on the old chain go away.

## 4. Backup before cutover (on Hetzner, as root)
```bash
cd /opt/clawd-chain-new
docker compose -p clawd-chain stop validator                       # brief downtime; or snapshot without stopping
tar czf /root/backup/ledger-$(date +%F).tgz -C /var/lib/docker/volumes/clawd-ledger/_data .
tar czf /root/backup/payments-$(date +%F).tgz -C /var/lib/docker/volumes/clawd-payments/_data .
tar czf /root/backup/percolator-house-$(date +%F).tgz /opt/percolator-house
cp deploy/hetzner/.env /root/backup/env-$(date +%F)                # chmod 600
for id in 2AMy… 79Y1… 6Grr… 85rg… GDaU…; do solana program dump $id /root/backup/$id.so; done
docker compose -p clawd-chain start validator
```
Copy `/root/backup` off-host (encrypted) before touching anything. Record current genesis hash + slot.

## 5. Secrets inventory (names only)
| Name | Where | Notes |
|---|---|---|
| `FAUCET_KEY` | Hetzner `.env`, Fly secret (validator gateway + faucet) | faucet keypair / gateway bypass |
| `POW_SECRET` | `.env`, Fly faucet | PoW HMAC |
| `SUPERMEMORY_API_KEY` | `.env` (optional) | chain brain |
| `FAUCET_PUBKEY`, `LEDGER_RESET_TOKEN` | `.env` / Fly (Alpenglow only) | not secret, but control genesis/wipe |
| `GIT_AUTH_TOKEN` | build host only | read-only token for clawd-percolator |
| `CLAWD_TOKEN` | `.env` | public mint address for the keeper (not secret) |
| Percolator house key | `/opt/percolator-house` (host volume) | never in git or images |
| Upgrade authority keypairs (`BfnaY…`, `D7nv…`) | offline / operator machine | needed for any program upgrade |
| Validator identity / vote keys | inside ledger volume | in the ledger backup |
| Fly API token | operator machine | only if using Fly |

## 6. DNS / RPC cutover
- Today: `rpc`, `explorer`, `faucet`, `percolator` `.clawdchain.trade` → Hetzner. **Do not change DNS for a same-host Hetzner deploy.**
- New genesis on same host: run the Alpenglow overlay on alternate ports first (or a staging hostname), smoke test, then swap compose and restart; DNS unchanged.
- Fly: point records at Fly only after section 8 passes on `*.fly.dev`; lower TTL to 60s a day before.

## 7. Rollback
- Same host, keep state: `docker compose -p clawd-chain up -d` with the previous images (tag them `:prev` before building).
- Alpenglow: the overlay uses `clawd-ledger-alpenglow`; rollback = drop the overlay and `up -d` — the old `clawd-ledger` volume is untouched.
- Fly: flip DNS back to Hetzner (keep Hetzner running until Fly has been stable 48h).
- Worst case: restore `/root/backup/ledger-*.tgz` into `clawd-ledger`.

## 8. Post-deploy smoke tests
- [ ] `getHealth`, `getVersion` (4.3.x for Alpenglow), `getGenesisHash`, slot advancing; Alpenglow: `getAgGenesisCert`.
- [ ] Faucet claim end-to-end at https://faucet.clawdchain.trade (PoW + 69 CLAWD).
- [ ] `node /workspace/perctest/flow.js` — open account, deposit, long, close, stake, unstake (10-slot cooldown) on the live market.
- [ ] Explorer home, a tx page, an address page; API `/health`; payments `/supported`; percolator `/` 200.
- [ ] price-keeper `prices.json` fresh (<30 s) and not `stale`.
- [ ] `solana program show` for all IDs: same authority, expected data length.

## Known issues / pending
- `test/shield.test.js` fails here and on the server: `clawd-shield-main/build/verification_key.json` + circuit artifacts are not in any repo (regenerate with circom/snarkjs or restore).
- percolator-prog build pin (`ENGINE_CI_SIBLING`) doesn't match the vendored engine in clawd-percolator — fix the pin before treating a build as a deploy artifact.
- Keeper is built, not wired: the Percolator server must read `PRICES_FILE` to quote trades; SOL-PERP/BTC-PERP markets still need creating (`initial_price` from keeper). Coming soon.
- Unstake during cooldown surfaces raw custom error `0x3` → map to "Stake is cooling down (10 slots)" in the private frontend.
- Docker images were validated with `docker compose config` only (no Docker daemon on the prep box) — run `docker compose build` on the host first.
