// Metaplex Core NFT create, fetch, update, transfer, and burn on a clawd RPC.
const { createUmi } = require('@metaplex-foundation/umi-bundle-defaults');
const { generateSigner, keypairIdentity, publicKey, sol } = require('@metaplex-foundation/umi');
const { mplCore, create, fetchAsset, updateV1, transferV1, burnV1 } = require('@metaplex-foundation/mpl-core');
const { validateNftCreate, validateNftName } = require('../lib/metadata');

const SEND = { send: { commitment: 'confirmed' }, confirm: { commitment: 'confirmed' } };

function clawdUmi(rpc, signer) {
  const umi = createUmi(rpc, 'confirmed').use(mplCore());
  if (signer) umi.use(keypairIdentity(signer));
  return umi;
}

async function fund(umi, payer, amount = 2) {
  await umi.rpc.airdrop(payer.publicKey, sol(amount));
  return payer;
}

function addressOf(value) {
  if (typeof value === 'string') return value;
  if (value && value.publicKey) return value.publicKey.toString();
  return String(value);
}

async function createNft(umi, { name, uri, metadata, asset } = {}) {
  const checked = validateNftCreate({ name, uri, metadata });
  if (!checked.ok) throw Object.assign(new Error(checked.reason), { reason: checked.reason });
  const signer = asset || generateSigner(umi);
  await create(umi, { asset: signer, name: checked.name, uri: checked.uri }).sendAndConfirm(umi, SEND);
  return { asset: signer.publicKey.toString(), name: checked.name, uri: checked.uri, metadata: checked.metadata };
}

async function fetchNft(umi, asset) {
  try {
    const account = await fetchAsset(umi, publicKey(addressOf(asset)));
    return {
      ok: true,
      gone: false,
      asset: account.publicKey.toString(),
      name: account.name,
      uri: account.uri,
      owner: account.owner.toString(),
    };
  } catch (error) {
    const reason = error && error.message ? error.message : String(error);
    const gone = /not of the expected type|AccountNotFound|could not find|does not exist/i.test(reason);
    return { ok: false, gone, reason };
  }
}

async function updateNft(umi, { asset, name, uri } = {}) {
  let nextName;
  if (name != null) {
    const checked = validateNftName(name);
    if (!checked.ok) throw Object.assign(new Error(checked.reason), { reason: checked.reason });
    nextName = checked.name;
  }
  await updateV1(umi, {
    asset: publicKey(addressOf(asset)),
    newName: nextName,
    newUri: uri,
  }).sendAndConfirm(umi, SEND);
  return fetchNft(umi, asset);
}

async function transferNft(umi, { asset, newOwner } = {}) {
  await transferV1(umi, {
    asset: publicKey(addressOf(asset)),
    newOwner: publicKey(addressOf(newOwner)),
  }).sendAndConfirm(umi, SEND);
  return fetchNft(umi, asset);
}

async function burnNft(umi, { asset, authority } = {}) {
  await burnV1(umi, {
    asset: publicKey(addressOf(asset)),
    authority,
  }).sendAndConfirm(umi, SEND);
  return fetchNft(umi, asset);
}

module.exports = {
  SEND,
  clawdUmi,
  fund,
  generateSigner,
  keypairIdentity,
  createNft,
  fetchNft,
  updateNft,
  transferNft,
  burnNft,
};
