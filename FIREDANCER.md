# Firedancer on clawd chain — plan (research, 2026-10-22)

## Findings
- **Firedancer (full client) supports Alpenglow** from v26.10.2 (mainnet-ready, 2026-10-14; latest v26.10.3, 2026-10-20). Enabled with `[consensus] alpenglow = true`
  (default in testnet/devnet configs). It aborts if its Alpenglow mode doesn't match the cluster. Supports all Solana 4.3 features. Tower→Alpenglow *migration* is not supported — irrelevant for us since clawd chain goes Alpenglow at genesis.
- **Frankendancer is out**: support ends with Alpenglow. Don't plan on it.
- Firedancer can now be an entrypoint for Agave validators, writes Agave-compatible vote history (safe failover both ways).
- Build from source only (Linux, kernel ≥4.18): `git checkout v26.10.3 && ./deps.sh && make -j`, run `firedancer run --config config.toml`.
- **Hardware:** official minimum 24 cores / 256 GB RAM / 2 TB NVMe (mainnet sizing). Our Hetzner box is 12 cores / 22 GB RAM — too small to co-host it next to Agave.
  An experimental `[layout] mode = "efficient"` lowers CPU use but isn't production-recommended; a tiny chain needs far less memory than mainnet, but hugepage/tile sizing must be tuned and tested.

## Blocker on our side
`solana-test-validator` (what clawd chain runs today, also for Alpenglow) is a single-node tool bound to 127.0.0.1; it can't take outside voters.
A second client (Firedancer) needs a real cluster: `solana-genesis` + `agave-validator` with gossip/TPU reachable.

## Plan
1. **Ship Alpenglow on test-validator first** (deploy/alpenglow/RESET-RUNBOOK.md). Keep this branch separate from that reset.
2. **Cluster-grade genesis (staging, Agave only):** write `deploy/alpenglow-cluster/` using `solana-genesis` with Alpenglow feature active at slot 0,
   the same `--bpf-program`/`--upgradeable-program` set from `programs.manifest`, faucet as mint; run `agave-validator` 4.3.2 as bootstrap leader. Smoke test on alternate ports.
3. **Firedancer staging node:** a separate box (e.g. Hetzner AX52/AX102 class, 16+ cores, 64–128 GB; or a rented 24c/256 GB for parity with docs) running
   Firedancer v26.10.3, `[consensus] alpenglow = true`, `[gossip] entrypoints = [bootstrap]`, own identity/vote (stake delegated from the faucet/stake key, test CLAWD only).
   Start non-voting → voting with small stake → check `getVoteAccounts`, skip rate, leader slots produced by Firedancer.
4. **Optional:** make Firedancer the RPC/leader-heavy node and keep Agave as the fallback (vote-history failover via `firedancer wait` + `set-identity --vote-history-file`).
5. Only after 1–4: decide whether production moves to a two-client cluster. No DNS change until then.

## Cost / risk
- New hardware is a spend → needs dev's approval before ordering.
- Two-validator cluster means real consensus (2 of 2 stake, or 3 nodes for fault tolerance) — plan for a third node or keep Agave majority stake.
- Upstream docs are mainnet-oriented; small-cluster Firedancer tuning is untested by us.
