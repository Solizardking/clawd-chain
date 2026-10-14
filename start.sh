#!/bin/bash
set -e
# One-shot ledger wipe: set LEDGER_RESET_TOKEN to a new value to wipe once; restarts with the same token keep the chain.
if [ -n "$LEDGER_RESET_TOKEN" ] && [ "$(cat /data/.reset_token 2>/dev/null)" != "$LEDGER_RESET_TOKEN" ]; then
  echo "ledger reset requested ($LEDGER_RESET_TOKEN): wiping /data/ledger"
  rm -rf /data/ledger && echo "$LEDGER_RESET_TOKEN" > /data/.reset_token
fi
mkdir -p /data/ledger
df -h /data || true
CLONE=""
# Preload Metaplex Core, Core Candy Machine, Core Candy Guard from mainnet on first boot only
if [ ! -f /data/ledger/genesis.bin ]; then
  CLONE="--url https://api.mainnet-beta.solana.com \
    --clone-upgradeable-program CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d \
    --clone-upgradeable-program CMACYFENjoBMHzapRXyo1JZkVS6EtaDDzkjMrmQLvr4J \
    --clone-upgradeable-program CMAGAKJ67e9hRZgfC5SFTbZH8MgEmtqazKXjmkaJjWTJ"
fi
solana-test-validator --ledger /data/ledger --bind-address 0.0.0.0 \
  --rpc-port 8899 --limit-ledger-size ${LEDGER_LIMIT:-250000} --quiet $CLONE &
node /proxy.js &
wait -n
exit 1
