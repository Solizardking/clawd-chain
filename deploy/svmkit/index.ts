// clawd chain as code (SVMKit + Pulumi).
//  mode=single : one Hetzner box, Agave 4.3.2 with --alpenglow at genesis (matches live chain).
//  mode=multi  : N Agave validators from one solana-genesis with N bootstrap validators (stake split
//                evenly), optional Firedancer joiner. Votor needs >=60% stake for the slow path and
//                >=80% for the fast path, so no single node should hold more than 20% at steady state.
// All keypairs are Pulumi-managed secrets in stack state; nothing secret is written to the repo.
import * as pulumi from "@pulumi/pulumi";
import * as svmkit from "@svmkit/pulumi-svmkit";

const cfg = new pulumi.Config("clawd");
const remote = new pulumi.Config("remote");
const mode = cfg.get("mode") ?? "single";
const version = cfg.get("agaveVersion") ?? "4.3.2";
const hosts = cfg.requireObject<string[]>("hosts");
const fdHost = cfg.get("firedancerHost");
const user = remote.get("user") ?? "root";
const privateKey = remote.getSecret("privateKey") ?? pulumi.secret("UNSET-preview-only");

const ALPENGLOW = ["--alpenglow"];
const gossipPort = 8001, rpcPort = 8899, faucetPort = 9900;
const LAMPORTS = 1_000_000_000;

type N = { name: string; host: string; conn: svmkit.types.input.ssh.ConnectionArgs; machine: svmkit.machine.Machine; id: svmkit.KeyPair; vote: svmkit.KeyPair; stake: svmkit.KeyPair };
const nodes: N[] = (mode === "single" ? hosts.slice(0, 1) : hosts).map((host, i) => {
  const name = i === 0 ? "bootstrap" : `node${i}`;
  const conn = { host, user, privateKey };
  return { name, host, conn, machine: new svmkit.machine.Machine(`${name}-machine`, { connection: conn }),
    id: new svmkit.KeyPair(`${name}-identity`), vote: new svmkit.KeyPair(`${name}-vote`), stake: new svmkit.KeyPair(`${name}-stake`) };
});
const boot = nodes[0];

const faucetKey = new svmkit.KeyPair("faucet-key");
const treasuryKey = new svmkit.KeyPair("treasury-key");

for (const n of nodes) {
  new svmkit.firewall.Firewall(`${n.name}-firewall`, { connection: n.conn, params: { allowPorts: ["22/tcp", "8000:8020/tcp", "8000:8020/udp", `${rpcPort}/tcp`, "8900/tcp", `${faucetPort}/tcp`] } }, { dependsOn: [n.machine] });
  new svmkit.tuner.Tuner(`${n.name}-tuner`, { connection: n.conn, params: svmkit.tuner.getDefaultTunerParamsOutput({ variant: svmkit.tuner.TunerVariant.Generic }).apply((p) => ({ cpuGovernor: p.cpuGovernor, kernel: p.kernel, net: p.net, vm: p.vm, fs: p.fs })) }, { dependsOn: [n.machine] });
}

// One genesis for every validator; each multi-mode node is a bootstrap validator with equal stake.
const genesis = new svmkit.genesis.Solana("genesis", {
  connection: boot.conn,
  version,
  flags: {
    ledgerPath: "/home/sol/ledger",
    bootstrapValidators: nodes.map((n) => ({ identityPubkey: n.id.publicKey, votePubkey: n.vote.publicKey, stakePubkey: n.stake.publicKey })),
    bootstrapValidatorStakeLamports: 100 * LAMPORTS,
    faucetPubkey: faucetKey.publicKey,
    faucetLamports: 1000 * LAMPORTS,
    clusterType: "development",
    slotsPerEpoch: 8192,
    enableWarmupEpochs: true,
    inflation: "none",
    extraFlags: ALPENGLOW,
  },
  primordial: [
    ...nodes.map((n) => ({ pubkey: n.id.publicKey, lamports: 1000 * LAMPORTS })),
    { pubkey: treasuryKey.publicKey, lamports: 100_000 * LAMPORTS },
  ],
}, { dependsOn: [boot.machine] });

const faucet = new svmkit.faucet.Faucet("faucet", { connection: boot.conn, keypair: faucetKey.json, flags: { perRequestCap: 10 } }, { dependsOn: [genesis] });

const baseFlags: svmkit.types.input.agave.FlagsArgs = {
  rpcPort, gossipPort, dynamicPortRange: "8002-8020", rpcBindAddress: "0.0.0.0", privateRPC: false, onlyKnownRPC: false,
  walRecoveryMode: "skip_any_corrupted_record", limitLedgerSize: 50_000_000, fullSnapshotIntervalSlots: 1000,
  useSnapshotArchivesAtStartup: "when-newest", allowPrivateAddr: true, noWaitForVoteToStartLeader: false, rpcFaucetAddress: `${boot.host}:${faucetPort}`,
  extraFlags: ALPENGLOW,
};

const validators: svmkit.validator.Agave[] = [];
nodes.forEach((n, i) => {
  const peers = nodes.filter((x) => x !== n);
  const flags: svmkit.types.input.agave.FlagsArgs = {
    ...baseFlags,
    gossipHost: n.host,
    fullRpcAPI: i === 0,
    enableRpcTransactionHistory: i === 0,
    enableExtendedTxMetadataStorage: i === 0,
    noWaitForVoteToStartLeader: i === 0,
    ...(i === 0 ? {} : { entryPoint: [`${boot.host}:${gossipPort}`], knownValidator: peers.map((p) => p.id.publicKey), expectedGenesisHash: genesis.genesisHash }),
  };
  validators.push(new svmkit.validator.Agave(`${n.name}-agave`, {
    connection: n.conn, version, flags,
    keyPairs: { identity: n.id.json, voteAccount: n.vote.json },
    environment: { rpcURL: `http://${boot.host}:${rpcPort}` },
    startupPolicy: { waitForRPCHealth: i === 0 },
    shutdownPolicy: { force: true },
    timeoutConfig: { rpcServiceTimeout: 120 },
    info: { name: `clawd-${n.name}`, details: "clawd chain Alpenglow validator" },
  }, { dependsOn: [n.machine, genesis, faucet, ...(i === 0 ? [] : [validators[0]])] }));
});

// Optional Firedancer joiner (needs >=24 cores / 256 GB RAM). Alpenglow-from-genesis, so the
// "no Tower->Alpenglow migration" limit in Firedancer v26.10.2 does not apply.
if (mode === "multi" && fdHost) {
  const conn = { host: fdHost, user, privateKey };
  const m = new svmkit.machine.Machine("fd-machine", { connection: conn });
  const id = new svmkit.KeyPair("fd-identity"), vote = new svmkit.KeyPair("fd-vote");
  new svmkit.validator.Firedancer("fd", {
    connection: conn,
    keyPairs: { identity: id.json, voteAccount: vote.json },
    config: {
      user: "sol",
      gossip: { host: fdHost, entrypoints: [`${boot.host}:${gossipPort}`] },
      consensus: { identityPath: "/home/sol/validator-keypair.json", voteAccountPath: "/home/sol/vote-account-keypair.json", knownValidators: nodes.map((n) => n.id.publicKey), expectedGenesisHash: genesis.genesisHash },
      ledger: { path: "/home/sol/ledger", accountsPath: "/home/sol/accounts" },
      rpc: { port: rpcPort, private: true },
    },
  }, { dependsOn: [m, validators[0]] });
}

export const clusterMode = mode;
export const validatorIdentities = nodes.map((n) => n.id.publicKey);
export const genesisHash = genesis.genesisHash;
