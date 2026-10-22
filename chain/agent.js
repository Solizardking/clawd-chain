// Agent register, read, delegate, revoke, and one-mint bind on a clawd RPC.
const { Keypair, PublicKey } = require('@solana/web3.js');
const { getOrCreateAssociatedTokenAccount } = require('@solana/spl-token');
const { createUmi } = require('@metaplex-foundation/umi-bundle-defaults');
const {
  generateSigner,
  keypairIdentity,
  publicKey,
  createNoopSigner,
  isSome,
} = require('@metaplex-foundation/umi');
const { mplCore, execute, findAssetSignerPda, fetchAsset } = require('@metaplex-foundation/mpl-core');
const {
  mplAgentIdentity,
  mplAgentTools,
  registerIdentityV1,
  fetchAgentIdentityV2FromSeeds,
  registerExecutiveV1,
  delegateExecutionV1,
  revokeExecutionV1,
  findExecutiveProfileV1Pda,
  findExecutionDelegateRecordV1Pda,
  findAgentIdentityV2Pda,
  safeFetchExecutionDelegateRecordV1FromSeeds,
  setAgentTokenV1,
} = require('@metaplex-foundation/mpl-agent-registry');
const { mplToolbox } = require('@metaplex-foundation/mpl-toolbox');
const { mplTokenMetadata } = require('@metaplex-foundation/mpl-token-metadata');
const {
  genesis,
  initializeV2,
  findGenesisAccountV2Pda,
  FEE_WALLET,
  WRAPPED_SOL_MINT,
} = require('@metaplex-foundation/genesis');
const { validateAgentDocument } = require('../lib/agent-doc');
const { createNft, fund, SEND } = require('./nft');

const GENESIS_FEE_WALLET = '9kFjQsxtpBsaw8s7aUyiY3wazYDNgFP4Lj5rsBVVF8tb';

function agentUmi(rpc, signer) {
  const umi = createUmi(rpc, 'confirmed')
    .use(mplCore())
    .use(mplAgentIdentity())
    .use(mplAgentTools())
    .use(mplToolbox())
    .use(mplTokenMetadata())
    .use(genesis());
  if (signer) umi.use(keypairIdentity(signer));
  return umi;
}

function addressOf(value) {
  if (typeof value === 'string') return value;
  if (value && value.publicKey) return value.publicKey.toString();
  return String(value);
}

function tokenOf(option) {
  if (!option || !isSome(option)) return null;
  return option.value.toString();
}

function web3Keypair(signer) {
  return Keypair.fromSecretKey(signer.secretKey);
}

async function readAgent(umi, asset) {
  const assetKey = publicKey(addressOf(asset));
  const account = await fetchAsset(umi, assetKey);
  const identities = account.agentIdentities || [];
  const uri = identities[0] && identities[0].uri ? identities[0].uri : null;
  const [wallet] = findAssetSignerPda(umi, { asset: assetKey });
  const identity = await fetchAgentIdentityV2FromSeeds(umi, { asset: assetKey });
  return {
    asset: account.publicKey.toString(),
    uri,
    wallet: wallet.toString(),
    agentToken: tokenOf(identity.agentToken),
    identity: identity.publicKey.toString(),
  };
}

async function registerAgent(umi, { asset, document, uri } = {}) {
  const checked = validateAgentDocument(document);
  if (!checked.ok) throw Object.assign(new Error(checked.reason), { reason: checked.reason });
  if (typeof uri !== 'string' || uri.trim().length === 0) {
    throw Object.assign(new Error('registration uri is required'), { reason: 'registration uri is required' });
  }
  await registerIdentityV1(umi, {
    asset: publicKey(addressOf(asset)),
    agentRegistrationUri: uri.trim(),
  }).sendAndConfirm(umi, SEND);
  const read = await readAgent(umi, asset);
  if (read.uri !== uri.trim()) {
    throw Object.assign(new Error('registration uri was not stored'), { reason: 'registration uri was not stored' });
  }
  return { ...read, document: checked.document };
}

async function delegateAgent(umi, { asset, executive } = {}) {
  const exec = executive || generateSigner(umi);
  await registerExecutiveV1(umi, { authority: exec }).sendAndConfirm(umi, SEND);
  const assetKey = publicKey(addressOf(asset));
  const [executiveProfile] = findExecutiveProfileV1Pda(umi, { authority: exec.publicKey });
  const [agentIdentity] = findAgentIdentityV2Pda(umi, { asset: assetKey });
  await delegateExecutionV1(umi, {
    executiveProfile,
    agentAsset: assetKey,
    agentIdentity,
  }).sendAndConfirm(umi, SEND);
  const record = await safeFetchExecutionDelegateRecordV1FromSeeds(umi, {
    executiveProfile,
    agentAsset: assetKey,
  });
  return {
    executive: exec.publicKey.toString(),
    executiveProfile: executiveProfile.toString(),
    delegated: Boolean(record),
    authority: record ? record.authority.toString() : null,
  };
}

async function revokeAgent(umi, { asset, executive } = {}) {
  const assetKey = publicKey(addressOf(asset));
  const [executiveProfile] = findExecutiveProfileV1Pda(umi, {
    authority: publicKey(addressOf(executive)),
  });
  const [record] = findExecutionDelegateRecordV1Pda(umi, {
    executiveProfile,
    agentAsset: assetKey,
  });
  await revokeExecutionV1(umi, {
    executionDelegateRecord: record,
    agentAsset: assetKey,
    destination: umi.identity.publicKey,
  }).sendAndConfirm(umi, SEND);
  const after = await safeFetchExecutionDelegateRecordV1FromSeeds(umi, {
    executiveProfile,
    agentAsset: assetKey,
  });
  return { delegated: after != null, executive: addressOf(executive) };
}

async function bindAgentToken(umi, connection, payer, { asset, name, symbol, supply, uri } = {}) {
  const payerKey = payer.secretKey ? web3Keypair(payer) : payer;
  await getOrCreateAssociatedTokenAccount(
    connection,
    payerKey,
    new PublicKey(WRAPPED_SOL_MINT),
    new PublicKey(FEE_WALLET || GENESIS_FEE_WALLET),
    true,
  );
  const baseMint = generateSigner(umi);
  const checkedSupply = supply == null ? 1_000_000n : BigInt(supply);
  await initializeV2(umi, {
    baseMint,
    quoteMint: WRAPPED_SOL_MINT,
    fundingMode: 0,
    totalSupplyBaseToken: checkedSupply,
    name: name || 'Clawd Agent',
    symbol: symbol || 'CLAW',
    uri: uri || 'https://clawd.local/agent-token.json',
    decimals: 6,
  }).sendAndConfirm(umi, SEND);
  const [genesisAccount] = findGenesisAccountV2Pda(umi, {
    baseMint: baseMint.publicKey,
    genesisIndex: 0,
  });
  const assetKey = publicKey(addressOf(asset));
  const [assetSigner] = findAssetSignerPda(umi, { asset: assetKey });
  const authority = createNoopSigner(assetSigner);
  const setToken = setAgentTokenV1(umi, {
    asset: assetKey,
    genesisAccount,
    authority,
  });
  await execute(umi, {
    asset: { publicKey: assetKey },
    instructions: setToken,
    signers: [authority],
  }).sendAndConfirm(umi, SEND);
  const read = await readAgent(umi, asset);
  return {
    ...read,
    mint: baseMint.publicKey.toString(),
    genesisAccount: genesisAccount.toString(),
  };
}

module.exports = {
  SEND,
  agentUmi,
  fund,
  generateSigner,
  keypairIdentity,
  createNft,
  readAgent,
  registerAgent,
  delegateAgent,
  revokeAgent,
  bindAgentToken,
  GENESIS_FEE_WALLET,
};
