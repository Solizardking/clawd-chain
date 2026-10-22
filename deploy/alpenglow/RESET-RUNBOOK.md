# Alpenglow reset runbook (Hetzner 95.216.154.157) — NOT RUN, needs dev's final go

New genesis. All balances, NFTs, positions, stakes, shielded notes on genesis `4ZVXGevaJv4La9KmXVSoXMDi53s3M2CCadzSwXudVa5y` go away.
Old ledger volume `clawd-ledger` is never touched (rollback = start it again).

## State at prep time (2026-10-22 19:36 ET)
- Backup: `/root/backup/full-20261022T233624Z` (root-only, files 600)
  - `keys/volume/*-keypair.json` + tower (from the `clawd-ledger` volume), `keys/host-data/` (from `/data/ledger`)
  - `env/*.env` (all three deploy dirs), `percolator-house.tgz`
  - `ledger/` newest full snapshot `snapshot-1671712-…tar.zst`, `genesis.bin`, `genesis.tar.bz2` (taken live, no stop)
  - `programs/*.so` on-chain dumps + `SHA256SUMS`, `upgradeable-programs.txt`
  - `inventory.json`: genesis/slot/version (Agave 2.2.20), native supply (503,627,668.77 CLAWD), top 20 native holders, every SPL mint with authorities + all holders
- Image: `clawd-chain-validator-alpenglow:4.3.2` built on host from `/opt/clawd-chain-release` (main @ 22ef6ae + this branch).
- Staging boot on host (throwaway volume, no ports, then deleted): Agave 4.3.2, Alpenglow `A1pengvu…` active since epoch 0, slots advancing,
  all 6 manifest programs present with the same authorities and byte lengths, pre-seeded faucet keypair reused, gateway `getHealth` ok.
- **Gotcha found:** Agave 4.3 panics (`assertion failed: io_uring_supported()`) under Docker's default seccomp → overlay sets `security_opt: seccomp=unconfined`.

## Programs re-created at genesis (`programs.manifest`)
| Program | ID | Authority |
|---|---|---|
| clawd_shield | 2AMyS5oL… | BfnaYDoM…dFtf |
| clawd_amm | 79Y18fL6… | BfnaYDoM…dFtf |
| clawd_launch (unlabeled, deployed slot 25648 next to amm) | AC5Pa5Kt… | GEBb8MGt…17zM |
| Percolator wrapper / stake / nft | 6Grr3eyu… / 85rgQvJs… / GDaUkuhb… | D7nvng9i…fY6 |
Metaplex Core / Candy Machine / Guard / Token Metadata / registries are re-cloned from mainnet by `start.sh`.
Token-2022 is NOT on the current chain either (the new genesis on 4.3 includes it as a builtin — check `TokenzQd…` works).

## 0. Pre-flight (T-24h)
- [ ] Announce reset window (explorer banner, X, README). Freeze launchpad/percolator new positions.
- [ ] Fresh inventory + backup right before the window: re-run `/root/inv.js` into a new `full-<ts>` dir.
- [ ] Decide faucet funding: set `FAUCET_PUBKEY=3gGxCtJ8Npqp26rDFfpa4u4Px8eniF3oxjPS3RMDqYJJ` in `/opt/clawd-chain/deploy/hetzner/.env`
      so the old faucet address is the genesis mint (≈500M CLAWD, matching today's supply). Without it the faucet only gets 1M.

## 1. Seed the new ledger volume (validator still running old chain)
```bash
B=/root/backup/full-<ts>; docker volume create clawd-ledger-alpenglow
M=/var/lib/docker/volumes/clawd-ledger-alpenglow/_data; mkdir -p $M/programs $M/seed; chmod 700 $M/seed
cp $B/programs/*.so /opt/clawd-chain-release/deploy/alpenglow/programs.manifest $M/programs/
install -m 600 $B/keys/volume/faucet-keypair.json $M/seed/faucet-keypair.json   # copy only; keeps faucet address
```
Optional (keep validator identity/vote addresses): seed validator/vote keypairs the same way — test-validator generates new ones otherwise (harmless for a single node).

## 2. Cutover (downtime starts)
```bash
cd /opt/clawd-chain/deploy/hetzner
docker compose -p clawd-chain -f compose.json stop validator              # old chain stops; volume kept
docker tag clawd-chain-validator-alpenglow:4.3.2 clawd-chain-validator-alpenglow:latest
docker compose -p clawd-chain -f compose.json -f /opt/clawd-chain-release/deploy/hetzner/docker-compose.alpenglow.yml \
  --env-file .env up -d --no-deps --no-build validator
docker logs -f clawd-chain-validator-1   # wait for "rpc gateway on 8080" and Alpenglow "active since epoch 0"
```
(Overlay's `build:` context is relative to the first compose file, so always pass `--no-build` and use the prebuilt image.)

## 3. Re-create CLAWD-side state (needs signing — dev approves each)
- Native CLAWD: comes from genesis (faucet = mint, step 0).
- Re-airdrop native CLAWD to holders from `inventory.json.largest` (skip system/faucet/house addresses) via faucet-key transfers; script reads inventory, dry-run first, prints the plan.
- SPL mints (cUSD `6ygBhzf5…`, `wDaoGBf5…`, `HCqVxVHt…`, `366scLJc…`, `3Tfx…`, `GwQ6…`): new addresses unless the original mint keypairs exist; re-mint balances to `allHolders` from inventory with the respective mint authority (D7nvng9… for cUSD/wDao — operator machine).
- Percolator: re-run market bootstrap from the private repo, update `/opt/percolator-house/markets.json` + `deploy/clawd-percolator.json`.
- Shield pool re-init; launchpad history archived.

## 4. Restart dependents
```bash
cd /opt/clawd-chain/deploy/hetzner && docker compose -p clawd-chain -f compose.json --env-file .env up -d --no-deps --force-recreate explorer api
cd /opt/clawd-chain-git/deploy/hetzner && docker compose -p clawd-chain -f compose.json --env-file .env up -d --no-deps --force-recreate faucet payments percolator-launch
```

## 5. Smoke tests
- [ ] `getHealth`, `getVersion` = 4.3.2, `getGenesisHash` (new, publish it), slot advancing; `solana feature status A1pengvu…` active.
- [ ] `solana program show` each manifest ID → same authority + length as `upgradeable-programs.txt`.
- [ ] Faucet claim end-to-end (69 CLAWD, 12h); explorer home/tx/address; api `/health`, `/openapi.json`; payments `/supported`; percolator `/` 200.
- [ ] `node /workspace/perctest/flow.js` against the new markets.
- [ ] Update README/explorer genesis hash, wallet extension default network.

## 6. Rollback (any failure before announcing success)
```bash
cd /opt/clawd-chain/deploy/hetzner
docker compose -p clawd-chain -f compose.json -f /opt/clawd-chain-release/deploy/hetzner/docker-compose.alpenglow.yml stop validator
docker compose -p clawd-chain -f compose.json --env-file .env up -d --no-deps --no-build --force-recreate validator   # old image + clawd-ledger
docker compose -p clawd-chain -f compose.json --env-file .env up -d --no-deps --force-recreate explorer api
```
The old chain resumes at its last slot (genesis 4ZVXGev…). Worst case: restore `ledger/snapshot-*.tar.zst` + keys from the backup into `clawd-ledger`.
`clawd-ledger-alpenglow` can be kept for a retry or removed with `docker volume rm` (dev's call).
