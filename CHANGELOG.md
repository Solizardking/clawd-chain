# Changelog

## 2026-10-23 · release/ore-alpenglow

### Chain: Alpenglow
- Validator moved to **Agave 4.3.2** with **Alpenglow** (SIMD-0326, feature `A1pengvuM6JEcyNuTnMqepBKhwHE3N6PmUrdATGawhJS`) active from epoch 0.
- New genesis: `BjbvUdJLreJzCfVEQZHi3D4QttNyp3P5mNXEvHw56kBP` (2026-10-22). All existing programs were loaded at the same addresses with the same upgrade authorities.
- Faucet: 69 CLAWD per wallet every 12h, 138 per IP. API `faucet_info` fields are now `amountPerWalletPer12h`, `ipCapPer12h` and `windowHours`.
- Ops: `deploy/alpenglow/` (start script, program manifest, reset runbook) and `deploy/hetzner/docker-compose.alpenglow.yml`.

### Explorer site
- New **/alpenglow** page with live processed/finalized slot and finality lag.
- New **/ore** page: how mining works, diagram, addresses, real claim tx, CLI steps.
- Nav links to both pages on every page, plus `llms.txt` entries.

### ORE mining (programs/ore)
ORE v3.1.0 (upstream `regolith-labs/ore` @ `c89f73e8`, Apache-2.0) proof-of-work line, ported to clawd chain.
| | Address |
|---|---|
| ORE program | `2QHkgHHPxFUak2MC16QvB6zh7aeKQn1ehEn1sEsTaaCP` |
| Noop program | `EHLnnhgdE1tq4bvLaTUaqs6bbmMMT6q88t1ZxDxLcwts` |
| cORE mint (test token, no value) | `5e2NA8PVis1QCx3aT5qmdFDW3KFJFnpY7WCf26Ds8XT7` |

Test run, 2026-10-22:
- [deploy](https://explorer.clawdchain.trade/tx/4Ua2utvi4x2gVfS4B9DjYSK93HZCyT8SCSdY86rCizfVd6rVzmwb8We3ieR3as6Mpwqmd75g8TRF8GfXZdrA2ohZ) · [noop deploy](https://explorer.clawdchain.trade/tx/3RaZeJnENpPAC569vY6wNfs35DLsFDuej1mqWxov9csh8x6U1krZRacuqApYjfdQaebBWUyjJXio8pc5LKxLNGAB) · [initialize](https://explorer.clawdchain.trade/tx/2C4Nd2vgxopJ412JEhbwc5DjBEg4X4Fr5ykogysmcYiJG9RsRP47Ai6RL562LiveCBf1hsRpW7bPXMVH4BVfmiCD) · [open](https://explorer.clawdchain.trade/tx/4ThawvPSDyLfW4itqpw5jZ9fESVPbFb2gysyBSrSYfTrsTm1n7GPhT8PKPyaSWaQgzrin6oJXha3BaHbPpTauWHY)
- mine [#1](https://explorer.clawdchain.trade/tx/2jvKGQQCg2fyVzvX24VtLv96ueEeeQGpWtpjQxzCeY6yzhzNejpxNYEfa61EKBkekWbSTFFe8jvV9UBJqu34pdrW) (diff 10) · [#2](https://explorer.clawdchain.trade/tx/3sE96kKVPQyNvsmiTTDLhpmNqeNYRq7RDKkk5Jbh4ZQpbYfJjiTNEGyuExyEdEL3Cg6yHXrUJe48X9TaX2AQB4b5) (diff 11) · [#3](https://explorer.clawdchain.trade/tx/5qPBft6FaSpGNGfaGzbubs16D1rot5dpnznmRoFStN21q1AK2L1FX7JonTy4wYAoDHT46RHt6iF1nBXdyiQTkZRV) (diff 9)
- [claim 57,344 grains cORE](https://explorer.clawdchain.trade/tx/4ZuZNXZFzfDiz5hSCRasEzxyozZagHwoGVzrZTX8uVNZuPTMDyR8CBcox1h5rfj3FfhfFAyiJejXZTeNkgW5wPJ8)

Coming soon: CLAWD rewards, boosts, staking, and moving the admin to a dedicated key or multisig.

### SVM Kit (deploy/svmkit)
Pulumi project with `single` and `multi` validator stacks. SSH key and validator keypairs live only in Pulumi secrets. Preview dry run passed. Nothing has been provisioned yet.

### Faremeter x402 gate (payments/x402)
Self-hosted facilitator plus a gate that charges 0.001 wrapped CLAWD for `GET /api/premium/chain-stats`. Keypairs are read from paths outside the repo. Tested locally: [settlement tx](https://explorer.clawdchain.trade/tx/3qU8aesdAfyG6SyChhFuqZP4tzhGovP2koVR92oGovbwo8WaPDLzDEvfLtnCFPqvujo6pme29n3UmpQUeN2mveeB). Not deployed publicly yet.

### Firedancer
Plan and staging notes in [FIREDANCER.md](FIREDANCER.md). Firedancer validators will run alongside Agave once its Alpenglow support is ready.
