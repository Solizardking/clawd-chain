# Firedancer node (NOT on Fly) — Hetzner bare metal
Fly Machines max out at 16 vCPU / 128 GB RAM in Firecracker VMs with no control over kernel boot
hugepage reservation; Firedancer needs >=24 cores, 256 GB RAM, 1 GiB gigantic pages reserved at
boot, and real root. So the Firedancer node runs on a Hetzner dedicated box (e.g. AX162-R / AX102-class)
and joins the Fly Agave bootstrap as a second Alpenglow validator.

Build (v26.10.3+, Alpenglow support from v26.10.2):
  git clone https://github.com/firedancer-io/firedancer && cd firedancer && git checkout v26.10.3
  ./deps.sh && make -j fdctl firedancer
  sudo ./build/native/gcc/bin/firedancer configure init all --config fd.toml
  sudo ./build/native/gcc/bin/firedancer run --config fd.toml
Note: joining requires the Agave bootstrap to run as a real multi-node cluster (solana-genesis +
agave-validator with gossip on a dedicated IPv4 UDP), not solana-test-validator. See ../README.md Phase 2.
