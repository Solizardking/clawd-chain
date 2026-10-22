#!/bin/bash
# Start clawd chain on ubuntu-24gb-hel1-1 (95.216.154.157, Helsinki).
# FAUCET_KEY and POW_SECRET come from the environment or deploy/hetzner/.env.
set -euo pipefail
cd "$(dirname "$0")"
if [[ -z "${FAUCET_KEY:-}" || -z "${POW_SECRET:-}" ]]; then
  if [[ -f .env ]]; then
    set -a
    # shellcheck disable=SC1091
    source .env
    set +a
  fi
fi
if [[ -z "${FAUCET_KEY:-}" || -z "${POW_SECRET:-}" ]]; then
  echo "Set FAUCET_KEY and POW_SECRET in the environment or deploy/hetzner/.env" >&2
  exit 1
fi
args=(-f compose.json up -d --build)
if [[ -f .env ]]; then
  args=(--env-file .env "${args[@]}")
fi
exec docker compose "${args[@]}" "$@"
