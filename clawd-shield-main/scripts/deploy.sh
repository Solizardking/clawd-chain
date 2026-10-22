#!/bin/bash
# rate-limit-tolerant deploy: write-buffer retries, verify, deploy from buffer
set -u
SO=$1; PID=$2; RPC=${RPC:-http://95.216.154.157:8080}
K=.keys/deployer.json
[ -f .keys/buffer.json ] || solana-keygen new --no-bip39-passphrase -s -o .keys/buffer.json >/dev/null
BUF=$(solana-keygen pubkey .keys/buffer.json)
for i in $(seq 1 15); do
  solana program write-buffer "$SO" --buffer .keys/buffer.json -u $RPC -k $K --use-rpc >/tmp/wb.log 2>&1
  solana program dump $BUF /tmp/buf.so -u $RPC >/dev/null 2>&1
  if cmp -s <(head -c $(stat -f%z "$SO") /tmp/buf.so) "$SO"; then echo "buffer ok after $i"; break; fi
  echo "retry $i: $(tail -1 /tmp/wb.log)"; sleep 8
done
solana program deploy --buffer $BUF --program-id $PID -u $RPC -k $K --upgrade-authority $K && rm -f .keys/buffer.json
