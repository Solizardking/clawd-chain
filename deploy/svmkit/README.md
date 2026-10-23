# clawd chain as code (SVMKit)

Pulumi + [SVMKit](https://github.com/abklabs/svmkit) stack that reproduces clawd chain on bare metal over SSH. No cloud resources are created.

| Stack | What it builds |
|---|---|
| `single` | Today's chain: one Hetzner host, Agave 4.3.2, `--alpenglow` at genesis, faucet, firewall, tuner |
| `multi` | Multi-node genesis design: N bootstrap validators with equal stake in one genesis, plus an optional Firedancer joiner |

```bash
npm ci && npm run typecheck
pulumi login file://$PWD/.state        # local state, keys stay encrypted in state
pulumi stack select single
pulumi config set --secret remote:privateKey < ~/.ssh/id_ed25519   # never commit
pulumi preview                         # validated: single 12 resources, multi 30 resources
```

## Multi-node genesis design (Firedancer prerequisite)
- `solana-genesis` with every validator as a bootstrap validator, so stake is spread from slot 0. Votor's fast path needs 80% stake and the slow path 60%, so aim for no node above 20% stake.
- Alpenglow is on from genesis (`--alpenglow`), so Firedancer (v26.10.2+, Alpenglow support, no Tower migration) can join directly.
- Firedancer host minimum: 24 cores, 256 GB RAM, 2 TB NVMe (current box: 12 cores, 22 GB).
- Moving live chain to `multi` is a new genesis (chain reset); run it only with a holder snapshot and restore plan.

`pulumi up` is not run in CI and must be approved before it touches any host.
