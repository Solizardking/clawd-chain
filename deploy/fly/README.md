# Clawd Chain on Fly.io — fresh genesis, Alpenglow (Votor) consensus
Status: Phase 1 configs only. Nothing created on Fly, nothing deployed.

## What runs where
| App | Fly size | Volume | ~$/mo (iad) |
|---|---|---|---|
| clawd-chain-validator (Agave v4.3.2 test-validator, Alpenglow at genesis + proxy.js) | performance-8x, 32 GB (16 GB preset + 16 GB x $6) | 200 GB ($30) | ~$390 |
| clawd-chain-faucet / -api / -explorer | shared-cpu-1x 512 MB each | — | ~$11 |
| Dedicated IPv4 (optional, only for Phase 2 UDP gossip) | | | $2 |
Cheaper start: performance-4x/16 GB (~$180 + $30 volume). Egress $0.02/GB.
Firedancer: not possible on Fly (see firedancer-hetzner/README.md).

## Deploy (await dev's go)
    export PATH=$HOME/.fly/bin:$PATH
    cd ~/clawd-chain-fly && ./prep.sh
    fly apps create clawd-chain-validator --org personal
    fly volumes create ledger --app clawd-chain-validator --region iad --size 200 -y
    fly secrets set --app clawd-chain-validator FAUCET_PUBKEY=<faucet pubkey> LEDGER_RESET_TOKEN=genesis-1   # + SUPERMEMORY_API_KEY optional
    fly deploy validator/build -c validator/fly.toml
    fly logs -a clawd-chain-validator   # look for alpenglow feature 'active' + genesis info
    for s in faucet api explorer; do fly apps create clawd-chain-$s --org personal; done
    fly secrets set --app clawd-chain-faucet FAUCET_KEY=<base58 faucet secret> POW_SECRET=<random>
    for s in faucet api explorer; do fly deploy $s/build -c $s/fly.toml; done

## Verify
    curl -s https://clawd-chain-validator.fly.dev -XPOST -H 'content-type: application/json' \
      -d '{"jsonrpc":"2.0","id":1,"method":"getAgGenesisCert"}'
    curl -s ... '{"method":"getVersion"}'   # expect 4.3.x

## Phase 2 (multi-validator, Firedancer joins)
Replace solana-test-validator with solana-genesis + agave-validator (gossip 8001/udp, TPU/turbine
UDP range) on a Fly dedicated IPv4 with services bound to fly-global-services, then add the
Hetzner Firedancer node via [gossip].entrypoints. New genesis hash → repoint faucet/explorer.

## In this repo (release/v-next)
The `*/build` + `prep.sh` copy step is gone: each fly.toml points at a Dockerfile in the repo, so deploy from the repo root:

    fly deploy . -c deploy/fly/validator.fly.toml
    fly deploy faucet -c deploy/fly/faucet.fly.toml
    fly deploy api -c deploy/fly/api.fly.toml
    fly deploy . -c deploy/fly/explorer.fly.toml

Secrets are set with `fly secrets set` only (names in RELEASE.md). Nothing secret lives in these files.
