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
# First boot clones the programs NFT, token, agent, and x402 flows need.
# SPL Token and Token-2022 are built into the test validator. Do not clone Token-2022.
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
fi
solana-test-validator --ledger /data/ledger --bind-address 0.0.0.0 \
  --rpc-port 8899 --limit-ledger-size ${LEDGER_LIMIT:-250000} --quiet $CLONE &
VPID=$!
node /proxy.js &
PROXY_PID=$!
# The brain restarts on its own. If it exits, the validator and the faucet airdrop path stay up.
if [ -n "$SUPERMEMORY_API_KEY" ]; then
  (
    while true; do
      node /brain/server.js || true
      sleep 10
    done
  ) &
fi
while kill -0 "$VPID" 2>/dev/null && kill -0 "$PROXY_PID" 2>/dev/null; do
  sleep 2
done
exit 1
