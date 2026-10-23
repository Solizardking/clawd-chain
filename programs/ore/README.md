# ORE on clawd chain (test deployment)

Proof-of-work ORE ported to clawd chain (Agave 4.3.2, Alpenglow). **Test token only. It has no value.**

## Source and license
- Upstream: https://github.com/regolith-labs/ore at commit `c89f73e8` (v3.1.0, Feb 2025). This is the last line of releases that uses drillx hash proof-of-work with `initialize`/`open`/`mine`/`claim`.
- Current upstream (v3.8.x) has replaced PoW with a "board" game where miners deploy SOL onto squares. It also depends on the entropy, ore-mint and Jupiter programs, so it is not a hash miner. We intentionally ported the PoW line.
- License: Apache-2.0 (declared in upstream Cargo.toml).

## Changes vs upstream
| File | Change |
|---|---|
| `api/src/lib.rs` | `declare_id!` → `2QHkgHHPxFUak2MC16QvB6zh7aeKQn1ehEn1sEsTaaCP` (new keypair, held off-repo) |
| `api/src/consts.rs` | `INITIALIZER_ADDRESS` → clawd test wallet `2TgZuzh7…H67Q2`; `NOOP_PROGRAM_ID` → `EHLnnhgdE1tq4bvLaTUaqs6bbmMMT6q88t1ZxDxLcwts` (our own noop); metadata name `ORE on clawd`, symbol `cORE` |
| `noop/` | New. A 1-line noop program, because the upstream `noop8yte…` program does not exist on clawd chain and `mine` uses it for proof authentication via introspection |
| `clawd-cli/` | New. A minimal CLI (`init`, `open`, `status`, `mine N`, `claim`). Upstream ore-cli is now a wallet/stake CLI that no longer mines |

All PDAs (config, 8 buses, treasury, mint) are derived from the new program ID, so the mint is new: `5e2NA8PVis1QCx3aT5qmdFDW3KFJFnpY7WCf26Ds8XT7` (11 decimals, max supply 5M). The CLAWD native coin is untouched.

## Deployed addresses (clawd chain)
- Program: `2QHkgHHPxFUak2MC16QvB6zh7aeKQn1ehEn1sEsTaaCP` (upgrade authority: test wallet)
- Noop: `EHLnnhgdE1tq4bvLaTUaqs6bbmMMT6q88t1ZxDxLcwts`
- Mint `5e2NA8PV…8XT7` · Config `FR7sS8p5…vund` · Treasury `61YhdYL8…35nX`

## Build
```bash
# programs (Solana platform-tools via cargo-build-sbf, solana-cli 4.3.x)
(cd program && cargo-build-sbf)
(cd noop && cargo-build-sbf)
# CLI (stable Rust; uses system OpenSSL)
OPENSSL_NO_VENDOR=1 cargo +stable build --release -p clawd-ore-cli
```

## Deploy (fresh IDs)
```bash
solana-keygen new -o keys/ore-program.json; solana-keygen new -o keys/noop-program.json   # keep out of git, chmod 600
# put the pubkeys into api/src/lib.rs (declare_id) and api/src/consts.rs (NOOP_PROGRAM_ID, INITIALIZER_ADDRESS), rebuild
solana program deploy noop/target/deploy/clawd_noop.so --program-id keys/noop-program.json -u https://rpc.clawdchain.trade
solana program deploy target/deploy/ore.so --program-id keys/ore-program.json -u https://rpc.clawdchain.trade
KEYPAIR=<initializer.json> clawd-ore init
```
Cost: about 1.8 CLAWD for the ORE program buffer/rent plus a little for the noop, init and accounts.

## Mine
```bash
export KEYPAIR=~/my-wallet.json RPC=https://rpc.clawdchain.trade
clawd-ore open      # create proof account
clawd-ore mine 3    # one hash/min (protocol cadence), auto-reset each 5-min epoch
clawd-ore claim     # proof balance → your cORE token account
```

## Test run (2026-10-22)
- deploy https://explorer.clawdchain.trade/tx/4Ua2utvi4x2gVfS4B9DjYSK93HZCyT8SCSdY86rCizfVd6rVzmwb8We3ieR3as6Mpwqmd75g8TRF8GfXZdrA2ohZ
- noop deploy https://explorer.clawdchain.trade/tx/3RaZeJnENpPAC569vY6wNfs35DLsFDuej1mqWxov9csh8x6U1krZRacuqApYjfdQaebBWUyjJXio8pc5LKxLNGAB
- upgrade (noop id) https://explorer.clawdchain.trade/tx/38ybiDZyWW2b9UWWgBQaS4ago697L8jMKyMgqpccKk6jVfps8ALftzx6PjQS8W8RFvC3R6ELRwMwo5shwJ7CFM6y
- initialize https://explorer.clawdchain.trade/tx/2C4Nd2vgxopJ412JEhbwc5DjBEg4X4Fr5ykogysmcYiJG9RsRP47Ai6RL562LiveCBf1hsRpW7bPXMVH4BVfmiCD
- open https://explorer.clawdchain.trade/tx/4ThawvPSDyLfW4itqpw5jZ9fESVPbFb2gysyBSrSYfTrsTm1n7GPhT8PKPyaSWaQgzrin6oJXha3BaHbPpTauWHY
- mine #1 (reset+mine, diff 10) https://explorer.clawdchain.trade/tx/2jvKGQQCg2fyVzvX24VtLv96ueEeeQGpWtpjQxzCeY6yzhzNejpxNYEfa61EKBkekWbSTFFe8jvV9UBJqu34pdrW
- mine #2 (diff 11) https://explorer.clawdchain.trade/tx/3sE96kKVPQyNvsmiTTDLhpmNqeNYRq7RDKkk5Jbh4ZQpbYfJjiTNEGyuExyEdEL3Cg6yHXrUJe48X9TaX2AQB4b5
- mine #3 (diff 9) https://explorer.clawdchain.trade/tx/5qPBft6FaSpGNGfaGzbubs16D1rot5dpnznmRoFStN21q1AK2L1FX7JonTy4wYAoDHT46RHt6iF1nBXdyiQTkZRV
- claim 57,344 grains https://explorer.clawdchain.trade/tx/4ZuZNXZFzfDiz5hSCRasEzxyozZagHwoGVzrZTX8uVNZuPTMDyR8CBcox1h5rfj3FfhfFAyiJejXZTeNkgW5wPJ8

## Open items
- The upgrade authority and initializer are the shared test wallet. Move them to a dedicated admin key or multisig before any public use.
- Boost/stake rewards are not wired (boost accounts are optional in `mine`).
- Mining CLAWD itself (instead of the cORE test mint) would need a different reward path, because CLAWD is the native coin and the program cannot mint it. Dev decides.
