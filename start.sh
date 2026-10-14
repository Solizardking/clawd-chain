#!/bin/bash
# clawd validator supervisor: starts the validator + gateway, keeps /data from filling up.
L=/data/ledger
export RUST_LOG=${RUST_LOG:-warn}
DISK_PURGE_PCT=${DISK_PURGE_PCT:-70}     # purge+compact when /data usage reaches this
DISK_HARD_PCT=${DISK_HARD_PCT:-85}       # still above after purge: drop blockstore, restart from latest snapshot
LOG_MAX_MB=${LOG_MAX_MB:-50}
log(){ echo "[supervisor $(date -u +%FT%TZ)] $*"; }

# One-shot ledger wipe: set LEDGER_RESET_TOKEN to a new value to wipe once; restarts with the same token keep the chain.
if [ -n "$LEDGER_RESET_TOKEN" ] && [ "$(cat /data/.reset_token 2>/dev/null)" != "$LEDGER_RESET_TOKEN" ]; then
  log "ledger reset requested ($LEDGER_RESET_TOKEN): wiping $L"
  rm -rf $L && echo "$LEDGER_RESET_TOKEN" > /data/.reset_token
fi
# One-shot recovery that KEEPS state: drop blockstore/tower/logs, restart from the latest snapshot.
if [ -n "$LEDGER_RECOVER_TOKEN" ] && [ "$(cat /data/.recover_token 2>/dev/null)" != "$LEDGER_RECOVER_TOKEN" ]; then
  log "recovery requested ($LEDGER_RECOVER_TOKEN): removing blockstore, tower and logs (snapshots kept)"
  rm -rf $L/rocksdb $L/tower-*.bin $L/validator-*.log $L/validator.log
  echo "$LEDGER_RECOVER_TOKEN" > /data/.recover_token
fi
mkdir -p $L
df -h /data || true

disk_pct(){ df -P /data | awk 'NR==2{gsub("%","",$5);print $5}'; }
latest_snap(){ ls $L/snapshot-*.tar.zst 2>/dev/null | sed -E 's/.*snapshot-([0-9]+)-.*/\1/' | sort -n | tail -1; }

VPID=""
start_validator(){
  local CLONE=""
  # Preload Metaplex Core, Core Candy Machine, Core Candy Guard from mainnet on first boot only
  if [ ! -f $L/genesis.bin ]; then
    CLONE="--url https://api.mainnet-beta.solana.com \
      --clone-upgradeable-program CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d \
      --clone-upgradeable-program CMACYFENjoBMHzapRXyo1JZkVS6EtaDDzkjMrmQLvr4J \
      --clone-upgradeable-program CMAGAKJ67e9hRZgfC5SFTbZH8MgEmtqazKXjmkaJjWTJ"
  fi
  solana-test-validator --ledger $L --bind-address 0.0.0.0 \
    --rpc-port 8899 --limit-ledger-size ${LEDGER_LIMIT:-100000} --quiet $CLONE &
  VPID=$!
  log "validator started pid $VPID"
}
stop_validator(){
  [ -n "$VPID" ] || return
  kill -TERM $VPID 2>/dev/null
  for i in $(seq 1 60); do kill -0 $VPID 2>/dev/null || break; sleep 1; done
  kill -KILL $VPID 2>/dev/null; wait $VPID 2>/dev/null; VPID=""
}
maintenance(){
  local before=$(disk_pct) snap=$(latest_snap)
  log "maintenance: disk ${before}% latest snapshot ${snap:-none}"
  stop_validator
  if [ -n "$snap" ] && [ -d $L/rocksdb ]; then
    # everything below the latest full snapshot is not needed to restart
    timeout 900 agave-ledger-tool -l $L purge 0 $((snap - 1)) --enable-compaction >/dev/null 2>&1 && log "purged slots < $snap"
  fi
  rm -f $L/validator-*.log
  if [ "$(disk_pct)" -ge "$DISK_HARD_PCT" ] && [ -n "$snap" ]; then
    log "still $(disk_pct)% after purge: dropping blockstore, restarting from snapshot $snap"
    rm -rf $L/rocksdb $L/tower-*.bin
  fi
  log "maintenance done: disk $(disk_pct)%"
  start_validator
}

start_validator
node /proxy.js &
PPID_GW=$!
while sleep 30; do
  kill -0 $PPID_GW 2>/dev/null || { log "gateway exited"; stop_validator; exit 1; }
  # keep the validator log bounded (logger may not reopen: truncate in place)
  f=$(readlink -f $L/validator.log 2>/dev/null)
  if [ -n "$f" ] && [ -f "$f" ] && [ $(( $(stat -c %s "$f") / 1048576 )) -ge $LOG_MAX_MB ]; then truncate -s 0 "$f"; fi
  if ! kill -0 $VPID 2>/dev/null; then log "validator exited"; maintenance; continue; fi
  [ "$(disk_pct)" -ge "$DISK_PURGE_PCT" ] && maintenance
done
