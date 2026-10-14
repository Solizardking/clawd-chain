#!/bin/bash
set -e
mkdir -p /data/ledger
CLONE=""
# Preload Metaplex Core, Core Candy Machine, Core Candy Guard from mainnet on first boot only
if [ ! -f /data/ledger/genesis.bin ]; then
  CLONE="--url https://api.mainnet-beta.solana.com \
    --clone-upgradeable-program CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d \
    --clone-upgradeable-program CMACYFENjoBMHzapRXyo1JZkVS6EtaDDzkjMrmQLvr4J \
    --clone-upgradeable-program CMAGAKJ67e9hRZgfC5SFTbZH8MgEmtqazKXjmkaJjWTJ"
fi
solana-test-validator --ledger /data/ledger --bind-address 0.0.0.0 \
  --rpc-port 8899 --limit-ledger-size 50000000 --quiet $CLONE &
node /proxy.js &
wait -n
exit 1
