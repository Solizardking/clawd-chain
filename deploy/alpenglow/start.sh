#!/bin/bash
# Fresh-genesis Clawd Chain on Agave 4.3.x. solana-test-validator activates the Alpenglow
# feature (A1pengvuM6JEcyNuTnMqepBKhwHE3N6PmUrdATGawhJS) at genesis and derives the BLS key
# from the vote keypair, so consensus is Votor from slot 0 (no TowerBFT migration).
set -e
if [ -n "$LEDGER_RESET_TOKEN" ] && [ "$(cat /data/.reset_token 2>/dev/null)" != "$LEDGER_RESET_TOKEN" ]; then
  rm -rf /data/ledger && echo "$LEDGER_RESET_TOKEN" > /data/.reset_token
fi
mkdir -p /data/ledger
CLONE=""
if [ ! -f /data/ledger/genesis.bin ]; then
  CLONE="--url https://api.mainnet-beta.solana.com \
    --clone So11111111111111111111111111111111111111112 \
    --clone-upgradeable-program CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d \
    --clone-upgradeable-program CMACYFENjoBMHzapRXyo1JZkVS6EtaDDzkjMrmQLvr4J \
    --clone-upgradeable-program CMAGAKJ67e9hRZgfC5SFTbZH8MgEmtqazKXjmkaJjWTJ \
    --clone-upgradeable-program 1DREGFgysWYxLnRnKQnwrxnJQeSMk2HmGaC6whw2B2p \
    --clone-upgradeable-program TLREGni9ZEyGC3vnPZtqUh95xQ8oPqJSvNjvB7FGK8S \
    --clone-upgradeable-program GNS1S5J5AspKXgpjz6SvKL66kPaKWAhaGRhCqPRxii2B \
    --clone-upgradeable-program metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s"
  # Faucet key funded at genesis: FAUCET_PUBKEY is a fly secret (pubkey only).
  [ -n "$FAUCET_PUBKEY" ] && FUND="--mint $FAUCET_PUBKEY"
  # Keep the old faucet address: pre-seed /data/seed/faucet-keypair.json (copied from the backup,
  # never baked into the image). solana-test-validator reuses an existing ledger faucet keypair.
  if [ -f /data/seed/faucet-keypair.json ]; then
    cp /data/seed/faucet-keypair.json /data/ledger/faucet-keypair.json && chmod 600 /data/ledger/faucet-keypair.json
  fi
  # Re-create programs at genesis with the SAME ids and upgrade authorities from on-chain dumps.
  # Manifest lines: <program_id> <file.so relative to PROGRAMS_DIR> <upgrade_authority_pubkey>
  PROGRAMS_DIR=${PROGRAMS_DIR:-/data/programs}
  if [ -f "$PROGRAMS_DIR/programs.manifest" ]; then
    while read -r pid so auth; do
      case "$pid" in ''|\#*) continue;; esac
      [ -f "$PROGRAMS_DIR/$so" ] || { echo "missing $PROGRAMS_DIR/$so" >&2; exit 1; }
      CLONE="$CLONE --upgradeable-program $pid $PROGRAMS_DIR/$so $auth"
    done < "$PROGRAMS_DIR/programs.manifest"
  fi
fi
solana-test-validator --ledger /data/ledger --bind-address 127.0.0.1 --alpenglow \
  --rpc-port 8899 --limit-blockstore-size ${LEDGER_LIMIT:-2000000} --quiet ${FUND:-} $CLONE &
VPID=$!
# Wait for RPC, then report Alpenglow status.
for i in $(seq 1 120); do solana -u http://127.0.0.1:8899 cluster-version >/dev/null 2>&1 && break; sleep 2; done
solana -u http://127.0.0.1:8899 feature status A1pengvuM6JEcyNuTnMqepBKhwHE3N6PmUrdATGawhJS || true
solana -u http://127.0.0.1:8899 alpenglow-genesis-info || true
UPSTREAM_HTTP=${UPSTREAM_HTTP:-http://127.0.0.1:8899} node /proxy.js &
PPID2=$!
if [ -n "$SUPERMEMORY_API_KEY" ]; then ( while true; do node /brain/server.js || true; sleep 10; done ) & fi
while kill -0 $VPID 2>/dev/null && kill -0 $PPID2 2>/dev/null; do sleep 2; done
exit 1
