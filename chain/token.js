// Fungible Token-2022 mint with on-mint name and symbol, plus a partial transfer.
const {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} = require('@solana/web3.js');
const {
  TOKEN_2022_PROGRAM_ID,
  ExtensionType,
  getMintLen,
  createInitializeMetadataPointerInstruction,
  createInitializeMintInstruction,
  createAssociatedTokenAccount,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  transfer,
  getAccount,
  getTokenMetadata,
  tokenMetadataInitializeWithRentTransfer,
} = require('@solana/spl-token');

const CONFIRM = { commitment: 'confirmed' };

function requireText(value, label, max) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw Object.assign(new Error(`${label} is required`), { reason: `${label} is required` });
  }
  const text = value.trim();
  if (max && text.length > max) {
    throw Object.assign(new Error(`${label} is over ${max}`), { reason: `${label} is over ${max}` });
  }
  return text;
}

function requireSupply(supply) {
  if (typeof supply !== 'bigint' && !Number.isSafeInteger(supply)) {
    throw Object.assign(new Error('supply must be a positive integer'), { reason: 'supply must be a positive integer' });
  }
  if (supply <= 0) {
    throw Object.assign(new Error('supply must be a positive integer'), { reason: 'supply must be a positive integer' });
  }
  return supply;
}

async function createFungibleToken(connection, payer, { name, symbol, uri, decimals = 0, supply } = {}) {
  const checkedName = requireText(name, 'name', 32);
  const checkedSymbol = requireText(symbol, 'symbol', 10);
  const checkedUri = requireText(uri, 'uri');
  const checkedSupply = requireSupply(supply);
  const mint = Keypair.generate();
  const mintLen = getMintLen([ExtensionType.MetadataPointer]);
  const lamports = await connection.getMinimumBalanceForRentExemption(mintLen);
  const createTx = new Transaction().add(
    SystemProgram.createAccount({
      fromPubkey: payer.publicKey,
      newAccountPubkey: mint.publicKey,
      space: mintLen,
      lamports,
      programId: TOKEN_2022_PROGRAM_ID,
    }),
    createInitializeMetadataPointerInstruction(
      mint.publicKey,
      payer.publicKey,
      mint.publicKey,
      TOKEN_2022_PROGRAM_ID,
    ),
    createInitializeMintInstruction(
      mint.publicKey,
      decimals,
      payer.publicKey,
      null,
      TOKEN_2022_PROGRAM_ID,
    ),
  );
  await sendAndConfirmTransaction(connection, createTx, [payer, mint], CONFIRM);
  await tokenMetadataInitializeWithRentTransfer(
    connection,
    payer,
    mint.publicKey,
    payer.publicKey,
    payer,
    checkedName,
    checkedSymbol,
    checkedUri,
    [],
    CONFIRM,
    TOKEN_2022_PROGRAM_ID,
  );
  const source = await createAssociatedTokenAccount(
    connection,
    payer,
    mint.publicKey,
    payer.publicKey,
    CONFIRM,
    TOKEN_2022_PROGRAM_ID,
  );
  await mintTo(
    connection,
    payer,
    mint.publicKey,
    source,
    payer,
    checkedSupply,
    [],
    CONFIRM,
    TOKEN_2022_PROGRAM_ID,
  );
  const metadata = await getTokenMetadata(connection, mint.publicKey, 'confirmed', TOKEN_2022_PROGRAM_ID);
  const account = await getAccount(connection, source, 'confirmed', TOKEN_2022_PROGRAM_ID);
  return {
    mint: mint.publicKey.toBase58(),
    name: metadata.name,
    symbol: metadata.symbol,
    uri: metadata.uri,
    supply: account.amount.toString(),
    source: source.toBase58(),
    decimals,
    program: TOKEN_2022_PROGRAM_ID.toBase58(),
  };
}

async function transferFungible(connection, payer, { mint, source, owner, recipient, amount } = {}) {
  const checkedAmount = requireSupply(amount);
  const mintKey = new PublicKey(mint);
  const dest = await getOrCreateAssociatedTokenAccount(
    connection,
    payer,
    mintKey,
    new PublicKey(recipient),
    false,
    'confirmed',
    CONFIRM,
    TOKEN_2022_PROGRAM_ID,
  );
  await transfer(
    connection,
    payer,
    new PublicKey(source),
    dest.address,
    owner,
    checkedAmount,
    [],
    CONFIRM,
    TOKEN_2022_PROGRAM_ID,
  );
  const from = await getAccount(connection, new PublicKey(source), 'confirmed', TOKEN_2022_PROGRAM_ID);
  const to = await getAccount(connection, dest.address, 'confirmed', TOKEN_2022_PROGRAM_ID);
  return {
    sender: from.amount.toString(),
    recipient: to.amount.toString(),
    amount: checkedAmount.toString(),
  };
}

module.exports = {
  createFungibleToken,
  transferFungible,
  TOKEN_2022_PROGRAM_ID,
};
