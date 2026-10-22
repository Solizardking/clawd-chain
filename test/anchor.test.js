const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { Keypair, PublicKey } = require('@solana/web3.js');
const anchor = require('../chain/anchor');
const assets = require('../chain/asset-program');
const chain = require('../chain');
const market = require('../chain/market');
const vault = require('../chain/vault');

const PUMP = '8cHzQHUS2s2h8TzCmfqPKYiM4dSt4roa3n7MyRLApump';
const FUND = 50_000_000n;

function pub() {
  return Keypair.generate().publicKey.toBase58();
}

function bytes(address) {
  return Buffer.from(new PublicKey(address).toBytes());
}

function pda(seeds, programId) {
  const [key, bump] = PublicKey.findProgramAddressSync(seeds, new PublicKey(programId));
  return { address: key.toBase58(), bump };
}

function disc(label) {
  return [...createHash('sha256').update(label).digest().subarray(0, 8)];
}

function lamports(book, address) {
  const rec = book.accounts.get(address);
  return rec ? rec.lamports : 0n;
}

function fund(book, address, amount = FUND) {
  const funded = anchor.fundChain(book, address, amount);
  assert.equal(funded.ok, true);
  return address;
}

test('discriminators match the published Anchor vectors', () => {
  const initialize = [175, 175, 109, 31, 13, 152, 155, 237];
  const newAccount = [176, 95, 4, 118, 91, 177, 125, 232];
  const counter = [255, 176, 4, 245, 188, 253, 124, 25];
  assert.deepEqual([...anchor.discriminator('global', 'initialize')], initialize);
  assert.deepEqual([...anchor.discriminator('account', 'NewAccount')], newAccount);
  assert.deepEqual([...anchor.discriminator('account', 'Counter')], counter);
  assert.deepEqual(disc('global:initialize'), initialize);
  assert.deepEqual(disc('account:NewAccount'), newAccount);
  assert.deepEqual(disc('account:Counter'), counter);
  assert.equal(chain.discriminator, anchor.discriminator);
  console.log(`discriminator global:initialize ${initialize.join(',')}`);
  console.log(`discriminator account:NewAccount ${newAccount.join(',')}`);
  console.log(`discriminator account:Counter ${counter.join(',')}`);
});

test('initialize credits a NewAccount and rolls rejected calls back', () => {
  const book = anchor.createChain();
  const payer = fund(book, pub());
  const client = assets.createAssetClient(book);
  const created = pub();
  const before = lamports(book, payer);
  const opened = client.methods.initialize(42n).accounts({
    newAccount: created,
    signer: payer,
    systemProgram: anchor.SYSTEM_PROGRAM_ID,
  }).signers([payer]).rpc();
  assert.equal(opened.ok, true);
  assert.equal(client.account.newAccount.fetch(created).data, 42n);
  assert.equal(client.account.NewAccount.fetch(created).data, 42n);
  const account = book.accounts.get(created);
  assert.equal(account.owner, assets.ASSET_PROGRAM_ID);
  assert.equal(before - lamports(book, payer), account.lamports);
  assert.ok(opened.logs.some(line => line.includes('Changed data to: 42!')));
  console.log(`initialize data 42 payer delta ${before - lamports(book, payer)}`);

  const afterOpen = lamports(book, payer);
  const again = client.methods.initialize(7n).accounts({
    newAccount: created,
    signer: payer,
    systemProgram: anchor.SYSTEM_PROGRAM_ID,
  }).signers([payer]).rpc();
  assert.equal(again.ok, false);
  assert.equal(again.reason, 'init');
  assert.equal(client.account.newAccount.fetch(created).data, 42n);
  assert.equal(lamports(book, payer), afterOpen);

  const missing = pub();
  const unsigned = client.methods.initialize(7n).accounts({
    newAccount: missing,
    signer: payer,
    systemProgram: anchor.SYSTEM_PROGRAM_ID,
  }).signers([]).rpc();
  assert.equal(unsigned.ok, false);
  assert.equal(unsigned.reason, 'signer');
  assert.equal(book.accounts.has(missing), false);
  assert.equal(lamports(book, payer), afterOpen);

  const wrongSystem = client.methods.initialize(7n).accounts({
    newAccount: pub(),
    signer: payer,
    systemProgram: pub(),
  }).signers([payer]).rpc();
  assert.equal(wrongSystem.ok, false);
  assert.equal(wrongSystem.reason, 'address');
  assert.equal(lamports(book, payer), afterOpen);

  const bumped = client.methods.increment().accounts({ counter: created }).signers([]).rpc();
  assert.equal(bumped.ok, true);
  assert.equal(client.account.newAccount.fetch(created).data, 43n);
  const found = client.account.newAccount.all();
  assert.equal(found.length, 1);
  assert.equal(found[0].publicKey, created);
  assert.equal(found[0].account.data, 43n);

  const garbage = pub();
  book.accounts.set(garbage, {
    address: garbage,
    owner: assets.ASSET_PROGRAM_ID,
    lamports: 1n,
    data: Buffer.alloc(16, 7),
    executable: false,
  });
  const rejected = client.methods.increment().accounts({ counter: garbage }).rpc();
  assert.equal(rejected.ok, false);
  assert.equal(rejected.reason, 'discriminator');
  assert.equal(client.account.newAccount.fetch(garbage), null);
  assert.equal(book.accounts.get(garbage).data[0], 7);
});

test('an init smaller than the encoded account fails closed', () => {
  const book = anchor.createChain();
  const payer = fund(book, pub());
  const tiny = anchor.defineProgram({
    id: pub(),
    name: 'tiny',
    accounts: { NewAccount: { fields: [{ name: 'data', type: 'u64' }] } },
    instructions: [{
      name: 'initialize',
      args: [{ name: 'data', type: 'u64' }],
      accounts: [
        { name: 'newAccount', type: 'NewAccount', init: { space: 8, payer: 'signer' } },
        { name: 'signer', signer: true, mut: true },
        { name: 'systemProgram', address: anchor.SYSTEM_PROGRAM_ID, executable: true },
      ],
      handler(ctx, { data }) {
        ctx.accounts.newAccount.data = data;
      },
    }],
  });
  const created = pub();
  const before = lamports(book, payer);
  const result = anchor.invoke(book, tiny, 'initialize', {
    newAccount: created,
    signer: payer,
    systemProgram: anchor.SYSTEM_PROGRAM_ID,
  }, [42n], [payer]);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'space');
  assert.equal(book.accounts.has(created), false);
  assert.equal(lamports(book, payer), before);
});

test('PDA seeds match findProgramAddressSync and a mismatched address is rejected', () => {
  const programId = pub();
  const marker = anchor.defineProgram({
    id: programId,
    name: 'marker',
    accounts: { Marker: { fields: [{ name: 'value', type: 'u64' }] } },
    instructions: [{
      name: 'init',
      args: [],
      accounts: [
        { name: 'payer', signer: true, mut: true },
        {
          name: 'marker',
          type: 'Marker',
          init: { space: 16, payer: 'payer' },
          seeds: ['marker', { account: 'payer' }],
        },
        { name: 'systemProgram', address: anchor.SYSTEM_PROGRAM_ID, executable: true },
      ],
      handler(ctx) {
        ctx.accounts.marker.value = 7n;
      },
    }],
  });
  const book = anchor.createChain();
  const payer = fund(book, pub());
  const expected = pda([Buffer.from('marker'), bytes(payer)], programId);
  const wrapped = anchor.findPda([Buffer.from('marker'), bytes(payer)], programId);
  assert.equal(wrapped.address, expected.address);
  assert.equal(wrapped.bump, expected.bump);

  const before = lamports(book, payer);
  const wrong = anchor.invoke(book, marker, 'init', {
    payer,
    marker: pub(),
    systemProgram: anchor.SYSTEM_PROGRAM_ID,
  }, [], [payer]);
  assert.equal(wrong.ok, false);
  assert.equal(wrong.reason, 'seeds');
  assert.equal(book.accounts.has(expected.address), false);
  assert.equal(lamports(book, payer), before);

  const opened = anchor.invoke(book, marker, 'init', {
    payer,
    systemProgram: anchor.SYSTEM_PROGRAM_ID,
  }, [], [payer]);
  assert.equal(opened.ok, true);
  assert.equal(opened.bumps.marker, expected.bump);
  assert.equal(book.accounts.get(expected.address).owner, programId);
  const client = anchor.createClient(book, marker);
  assert.equal(client.account.marker.fetch(expected.address).value, 7n);
  console.log(`pda ${expected.address} bump ${expected.bump}`);
});

test('CPI increments another program and CLAWD transfers honor signers', () => {
  const noteId = pub();
  const note = anchor.defineProgram({
    id: noteId,
    name: 'note',
    accounts: { Note: { fields: [{ name: 'hits', type: 'u64' }] } },
    instructions: [
      {
        name: 'initialize',
        args: [],
        accounts: [
          { name: 'note', type: 'Note', init: { space: 16, payer: 'payer' } },
          { name: 'payer', signer: true, mut: true },
          { name: 'systemProgram', address: anchor.SYSTEM_PROGRAM_ID, executable: true },
        ],
        handler(ctx) {
          ctx.accounts.note.hits = 0n;
        },
      },
      {
        name: 'increment',
        args: [],
        accounts: [{ name: 'note', type: 'Note', mut: true }],
        handler(ctx) {
          ctx.accounts.note.hits = ctx.accounts.note.hits + 1n;
        },
      },
    ],
  });
  const caller = anchor.defineProgram({
    id: pub(),
    name: 'caller',
    accounts: {},
    instructions: [{
      name: 'ping',
      args: [],
      accounts: [{ name: 'note', mut: true }],
      handler(ctx) {
        ctx.cpi(note, 'increment', { note: ctx.accounts.note.key() }, {}, []);
      },
    }],
  });
  const book = anchor.createChain();
  const payer = fund(book, pub());
  const noteAccount = pub();
  const opened = anchor.invoke(book, note, 'initialize', {
    note: noteAccount,
    payer,
    systemProgram: anchor.SYSTEM_PROGRAM_ID,
  }, [], [payer]);
  assert.equal(opened.ok, true);
  const ping = anchor.invoke(book, caller, 'ping', { note: noteAccount }, [], []);
  assert.equal(ping.ok, true);
  assert.equal(anchor.createClient(book, note).account.note.fetch(noteAccount).hits, 1n);
  console.log('cpi note hits 1');

  const from = fund(book, pub(), 20n);
  const to = fund(book, pub(), 1n);
  const unsigned = anchor.invoke(book, anchor.systemProgram, 'transfer', { from, to }, { amount: 5n }, []);
  assert.equal(unsigned.ok, false);
  assert.equal(unsigned.reason, 'signer');
  assert.equal(lamports(book, from), 20n);
  assert.equal(lamports(book, to), 1n);
  const forged = anchor.invoke(book, anchor.systemProgram, 'transfer', { from, to }, { amount: 5n }, [], [from]);
  assert.equal(forged.ok, false);
  assert.equal(forged.reason, 'signer');
  assert.equal(lamports(book, from), 20n);
  const moved = anchor.invoke(book, anchor.systemProgram, 'transfer', { from, to }, { amount: 5n }, [from]);
  assert.equal(moved.ok, true);
  assert.equal(lamports(book, from), 15n);
  assert.equal(lamports(book, to), 6n);
  const over = anchor.invoke(book, anchor.systemProgram, 'transfer', { from, to }, { amount: 100n }, [from]);
  assert.equal(over.ok, false);
  assert.equal(over.reason, 'balance');
  assert.equal(lamports(book, from), 15n);
  assert.equal(lamports(book, to), 6n);

  const client = assets.createAssetClient(book);
  const recipient = pub();
  const clawd = client.methods.clawdTransfer(4n).accounts({
    from,
    to: recipient,
    systemProgram: anchor.SYSTEM_PROGRAM_ID,
  }).signers([from]).rpc();
  assert.equal(clawd.ok, true);
  assert.equal(lamports(book, from), 11n);
  assert.equal(lamports(book, recipient), 4n);
  const clawdOver = client.methods.clawdTransfer(50n).accounts({
    from,
    to: pub(),
    systemProgram: anchor.SYSTEM_PROGRAM_ID,
  }).signers([from]).rpc();
  assert.equal(clawdOver.ok, false);
  assert.equal(clawdOver.reason, 'balance');
  assert.equal(lamports(book, from), 11n);

  const vaultPda = pda([Buffer.from('pda'), bytes(recipient)], assets.ASSET_PROGRAM_ID);
  assert.equal(anchor.findPda([Buffer.from('pda'), bytes(recipient)], assets.ASSET_PROGRAM_ID).address, vaultPda.address);
  fund(book, vaultPda.address, 9n);
  const viaPda = client.methods.clawdTransferPda(6n).accounts({
    recipient,
    systemProgram: anchor.SYSTEM_PROGRAM_ID,
  }).signers([]).rpc();
  assert.equal(viaPda.ok, true);
  assert.equal(lamports(book, vaultPda.address), 3n);
  assert.equal(lamports(book, recipient), 10n);
  const pdaOver = client.methods.clawdTransferPda(9n).accounts({
    recipient,
    systemProgram: anchor.SYSTEM_PROGRAM_ID,
  }).signers([]).rpc();
  assert.equal(pdaOver.ok, false);
  assert.equal(pdaOver.reason, 'balance');
  assert.equal(lamports(book, vaultPda.address), 3n);
  assert.equal(lamports(book, recipient), 10n);
  console.log(`clawd transfer 4 pda release 6`);
});

test('IDL carries instruction discriminators, account types, and PDA seeds', () => {
  assert.equal(anchor.extractIdl, anchor.idlOf);
  assert.equal(chain.idlOf, anchor.idlOf);
  const idl = anchor.idlOf(assets.program);
  assert.equal(idl.address, assets.ASSET_PROGRAM_ID);
  const initialize = idl.instructions.find(ix => ix.name === 'initialize');
  assert.deepEqual(initialize.discriminator, [175, 175, 109, 31, 13, 152, 155, 237]);
  assert.ok(idl.accounts.some(account => account.name === 'NewAccount'));
  assert.ok(idl.accounts.some(account => account.name === 'Counter'));
  const fungible = idl.instructions.find(ix => ix.name === 'createFungible');
  const metadata = fungible.accounts.find(account => account.name === 'metadata');
  assert.deepEqual(metadata.pda.seeds[0], { kind: 'const', value: 'metadata' });
  assert.deepEqual(metadata.pda.seeds[1], { kind: 'program' });
  assert.deepEqual(metadata.pda.seeds[2], { kind: 'account', path: 'mint' });
  const receipt = anchor.idlOf(assets.program).instructions.find(ix => ix.name === 'swapTokenToNft')
    .accounts.find(account => account.name === 'receipt');
  assert.deepEqual(receipt.pda.seeds[2], { kind: 'account', path: 'escrow.nextUri', type: 'u64' });
});

test('fungible metadata, transfer, freeze, and immutable metadata', () => {
  const book = anchor.createChain();
  const payer = fund(book, pub());
  const mint = pub();
  const bob = fund(book, pub());
  const client = assets.createAssetClient(book);
  const before = lamports(book, payer);
  const empty = client.methods.createFungible('', 'CLAW', 'https://clawdchain.trade/empty', 6, 1000n, 0).accounts({
    payer,
    mint,
    systemProgram: anchor.SYSTEM_PROGRAM_ID,
  }).signers([payer, mint]).rpc();
  assert.equal(empty.ok, false);
  assert.equal(empty.reason, 'name');
  assert.equal(book.accounts.has(mint), false);
  assert.equal(lamports(book, payer), before);

  const created = client.methods.createFungible('Clawd', 'CLAW', 'https://clawdchain.trade/clawd', 6, 1000n, 250).accounts({
    payer,
    mint,
    systemProgram: anchor.SYSTEM_PROGRAM_ID,
  }).signers([payer, mint]).rpc();
  assert.equal(created.ok, true);
  const metadata = pda([
    Buffer.from('metadata'),
    bytes(assets.ASSET_PROGRAM_ID),
    bytes(mint),
  ], assets.ASSET_PROGRAM_ID);
  const token = pda([Buffer.from('token'), bytes(mint), bytes(payer)], assets.ASSET_PROGRAM_ID);
  assert.equal(anchor.findPda([
    Buffer.from('metadata'),
    bytes(assets.ASSET_PROGRAM_ID),
    bytes(mint),
  ], assets.ASSET_PROGRAM_ID).address, metadata.address);
  const meta = client.account.assetMetadata.fetch(metadata.address);
  assert.equal(meta.name, 'Clawd');
  assert.equal(meta.symbol, 'CLAW');
  assert.equal(meta.uri, 'https://clawdchain.trade/clawd');
  assert.equal(meta.tokenStandard, 1);
  assert.equal(meta.isMutable, true);
  assert.equal(meta.sellerFeeBasisPoints, 250);
  assert.equal(book.accounts.get(metadata.address).owner, assets.ASSET_PROGRAM_ID);
  assert.equal(client.account.assetMint.fetch(mint).supply, 1000n);
  assert.equal(client.account.tokenAccount.fetch(token.address).amount, 1000n);
  console.log(`fungible supply 1000 metadata ${metadata.address}`);

  const plainMint = pub();
  const plain = client.methods.createFungible('A'.repeat(32), 'B'.repeat(10), 'u'.repeat(200), 0, 1n, 0).accounts({
    payer,
    mint: plainMint,
    systemProgram: anchor.SYSTEM_PROGRAM_ID,
  }).signers([payer, plainMint]).rpc();
  assert.equal(plain.ok, true);
  const plainMeta = pda([
    Buffer.from('metadata'),
    bytes(assets.ASSET_PROGRAM_ID),
    bytes(plainMint),
  ], assets.ASSET_PROGRAM_ID);
  assert.equal(client.account.assetMetadata.fetch(plainMeta.address).tokenStandard, 2);

  const bobToken = pda([Buffer.from('token'), bytes(mint), bytes(bob)], assets.ASSET_PROGRAM_ID);
  const opened = client.methods.initTokenAccount().accounts({
    payer,
    mint,
    owner: bob,
    systemProgram: anchor.SYSTEM_PROGRAM_ID,
  }).signers([payer]).rpc();
  assert.equal(opened.ok, true);
  const sent = client.methods.transfer(40n).accounts({
    authority: payer,
    source: token.address,
    destination: bobToken.address,
  }).signers([payer]).rpc();
  assert.equal(sent.ok, true);
  assert.equal(client.account.tokenAccount.fetch(token.address).amount, 960n);
  assert.equal(client.account.tokenAccount.fetch(bobToken.address).amount, 40n);
  console.log('transfer 40');

  const sourceBefore = client.account.tokenAccount.fetch(token.address).amount;
  const destBefore = client.account.tokenAccount.fetch(bobToken.address).amount;
  const tooMuch = client.methods.transfer(10000n).accounts({
    authority: payer,
    source: token.address,
    destination: bobToken.address,
  }).signers([payer]).rpc();
  assert.equal(tooMuch.ok, false);
  assert.equal(tooMuch.reason, 'balance');
  const wrongOwner = client.methods.transfer(1n).accounts({
    authority: bob,
    source: token.address,
    destination: bobToken.address,
  }).signers([bob]).rpc();
  assert.equal(wrongOwner.ok, false);
  assert.equal(wrongOwner.reason, 'owner');
  assert.equal(client.account.tokenAccount.fetch(token.address).amount, sourceBefore);
  assert.equal(client.account.tokenAccount.fetch(bobToken.address).amount, destBefore);

  const frozen = client.methods.freeze().accounts({
    authority: payer,
    mint,
    token: token.address,
  }).signers([payer]).rpc();
  assert.equal(frozen.ok, true);
  const blocked = client.methods.transfer(1n).accounts({
    authority: payer,
    source: token.address,
    destination: bobToken.address,
  }).signers([payer]).rpc();
  assert.equal(blocked.ok, false);
  assert.equal(blocked.reason, 'frozen');
  assert.equal(client.methods.thaw().accounts({
    authority: payer,
    mint,
    token: token.address,
  }).signers([payer]).rpc().ok, true);
  assert.equal(client.methods.transfer(1n).accounts({
    authority: payer,
    source: token.address,
    destination: bobToken.address,
  }).signers([payer]).rpc().ok, true);
  assert.equal(client.account.tokenAccount.fetch(token.address).amount, 959n);

  const updated = client.methods.updateMetadata('Clawd Coin', 'CLAWD', 'https://clawdchain.trade/new').accounts({
    authority: payer,
    metadata: metadata.address,
  }).signers([payer]).rpc();
  assert.equal(updated.ok, true);
  assert.equal(client.methods.freezeMetadata().accounts({
    authority: payer,
    metadata: metadata.address,
  }).signers([payer]).rpc().ok, true);
  const immutable = client.methods.updateMetadata('Nope', 'NO', 'https://clawdchain.trade/no').accounts({
    authority: payer,
    metadata: metadata.address,
  }).signers([payer]).rpc();
  assert.equal(immutable.ok, false);
  assert.equal(immutable.reason, 'mutable');
  assert.equal(client.account.assetMetadata.fetch(metadata.address).name, 'Clawd Coin');
  assert.equal(client.account.assetMetadata.fetch(metadata.address).isMutable, false);
});

test('hybrid swap keeps the fee on the escrow and stops at the end of the uri range', () => {
  const book = anchor.createChain();
  const creator = fund(book, pub());
  const mint = pub();
  const client = assets.createAssetClient(book);
  assert.equal(client.methods.createFungible('Hybrid', 'HYB', 'https://clawdchain.trade/hyb', 0, 10000n, 0).accounts({
    payer: creator,
    mint,
    systemProgram: anchor.SYSTEM_PROGRAM_ID,
  }).signers([creator, mint]).rpc().ok, true);
  const source = pda([Buffer.from('token'), bytes(mint), bytes(creator)], assets.ASSET_PROGRAM_ID);
  const escrow = pda([Buffer.from('hybrid'), bytes(mint)], assets.ASSET_PROGRAM_ID);
  const opened = client.methods.createHybrid(500, 1000n, 0n, 1n, 5000n).accounts({
    payer: creator,
    collection: mint,
    source: source.address,
    systemProgram: anchor.SYSTEM_PROGRAM_ID,
  }).signers([creator]).rpc();
  assert.equal(opened.ok, true);
  const escrowToken = pda([Buffer.from('token'), bytes(mint), bytes(escrow.address)], assets.ASSET_PROGRAM_ID);
  assert.equal(client.account.tokenAccount.fetch(source.address).amount, 5000n);
  assert.equal(client.account.tokenAccount.fetch(escrowToken.address).amount, 5000n);

  const toNft = client.methods.swapTokenToNft().accounts({
    user: creator,
    userToken: source.address,
    escrow: escrow.address,
    escrowToken: escrowToken.address,
    systemProgram: anchor.SYSTEM_PROGRAM_ID,
  }).signers([creator]).rpc();
  assert.equal(toNft.ok, true);
  assert.equal(client.account.tokenAccount.fetch(source.address).amount, 4000n);
  assert.equal(client.account.tokenAccount.fetch(escrowToken.address).amount, 6000n);
  const receipt = pda([
    Buffer.from('nft'),
    bytes(mint),
    Buffer.alloc(8),
  ], assets.ASSET_PROGRAM_ID);
  assert.equal(client.account.nftReceipt.fetch(receipt.address).uri, 0n);
  assert.equal(client.account.nftReceipt.fetch(receipt.address).burned, false);
  console.log('hybrid swap token 4000 escrow 6000');

  const back = client.methods.swapNftToToken().accounts({
    user: creator,
    userToken: source.address,
    escrow: escrow.address,
    escrowToken: escrowToken.address,
    receipt: receipt.address,
  }).signers([creator]).rpc();
  assert.equal(back.ok, true);
  assert.equal(client.account.tokenAccount.fetch(source.address).amount, 4950n);
  assert.equal(client.account.tokenAccount.fetch(escrowToken.address).amount, 5050n);
  assert.equal(client.account.nftReceipt.fetch(receipt.address).burned, true);
  console.log('hybrid swap back token 4950 escrow 5050 fee 50');

  const nextUri = Buffer.alloc(8);
  nextUri.writeBigUInt64LE(1n);
  const exhausted = pda([Buffer.from('nft'), bytes(mint), nextUri], assets.ASSET_PROGRAM_ID);
  const third = client.methods.swapTokenToNft().accounts({
    user: creator,
    userToken: source.address,
    escrow: escrow.address,
    escrowToken: escrowToken.address,
    systemProgram: anchor.SYSTEM_PROGRAM_ID,
  }).signers([creator]).rpc();
  assert.equal(third.ok, false);
  assert.equal(third.reason, 'args');
  assert.equal(book.accounts.has(exhausted.address), false);
  assert.equal(client.account.hybridEscrow.fetch(escrow.address).nextUri, 1n);
  assert.equal(client.account.tokenAccount.fetch(source.address).amount, 4950n);
  assert.equal(client.account.tokenAccount.fetch(escrowToken.address).amount, 5050n);
});

test('a CLAWD launch pool cranks collected lamports and claims integer shares', () => {
  const book = chain.createChain();
  const admin = fund(book, pub());
  const alice = fund(book, pub());
  const bob = fund(book, pub());
  const baseMint = pub();
  const client = chain.createAssetClient(book);
  const upcomingMint = pub();
  assert.equal(client.methods.createLaunch(
    'Later', 'LATE', 'https://clawdchain.trade/later', 6, 0, 100n, 1000n, 2000n, 2000n,
  ).accounts({
    payer: admin,
    baseMint: upcomingMint,
    systemProgram: anchor.SYSTEM_PROGRAM_ID,
  }).signers([admin, upcomingMint]).rpc().ok, true);
  const later = pda([Buffer.from('genesis'), bytes(upcomingMint)], assets.ASSET_PROGRAM_ID);
  assert.equal(chain.getLaunch(book, later.address).data.launch.status, 'upcoming');

  const opened = client.methods.createLaunch(
    'Clawd', 'CLAWD', 'https://clawdchain.trade/launch', 9, 0, 1000n, 0n, 100n, 101n,
  ).accounts({
    payer: admin,
    baseMint,
    systemProgram: anchor.SYSTEM_PROGRAM_ID,
  }).signers([admin, baseMint]).rpc();
  assert.equal(opened.ok, true);
  const genesis = pda([Buffer.from('genesis'), bytes(baseMint)], assets.ASSET_PROGRAM_ID);
  const independent = PublicKey.findProgramAddressSync(
    [Buffer.from('genesis'), bytes(baseMint)],
    new PublicKey(assets.ASSET_PROGRAM_ID),
  )[0].toBase58();
  assert.equal(genesis.address, independent);
  const view = client.account.genesis.fetch(genesis.address);
  const bucketRent = lamports(book, view.bucket);
  assert.equal(view.totalSupply, 1000n);
  assert.equal(view.deposited, 0n);
  assert.equal(chain.getLaunch(book, genesis.address).data.launch.status, 'live');
  assert.equal(chain.getLaunch(book, genesis.address).data.launch.mechanic, 'launchpoolV2');
  assert.equal(chain.getLaunch(book, genesis.address).data.launch.type, 'launchpool');
  assert.equal(chain.getLaunch(book, genesis.address).data.launch.launchPage, `https://clawdchain.trade/launch/${genesis.address}`);
  assert.equal(chain.getLaunch(book, genesis.address).data.baseToken.symbol, 'CLAWD');
  assert.equal(chain.getLaunch(book, pub()).error.message, 'Launch not found');

  function depositAccounts(user) {
    return {
      user,
      genesis: genesis.address,
      systemProgram: anchor.SYSTEM_PROGRAM_ID,
    };
  }
  assert.equal(client.methods.deposit(30n).accounts(depositAccounts(alice)).signers([alice]).rpc().ok, true);
  assert.equal(client.methods.withdraw(10n).accounts(depositAccounts(alice)).signers([alice]).rpc().ok, true);
  assert.equal(client.methods.deposit(70n).accounts(depositAccounts(bob)).signers([bob]).rpc().ok, true);
  const midway = client.account.genesis.fetch(genesis.address);
  assert.equal(midway.deposited, 90n);
  assert.equal(midway.clawdCollected, 90n);
  assert.equal(lamports(book, midway.bucket), bucketRent + 90n);
  const aliceDeposit = pda([
    Buffer.from('deposit'),
    bytes(midway.bucket),
    bytes(alice),
  ], assets.ASSET_PROGRAM_ID);
  const bobDeposit = pda([
    Buffer.from('deposit'),
    bytes(midway.bucket),
    bytes(bob),
  ], assets.ASSET_PROGRAM_ID);
  assert.equal(client.account.deposit.fetch(aliceDeposit.address).amount, 20n);
  assert.equal(client.account.deposit.fetch(bobDeposit.address).amount, 70n);

  chain.setTime(book, 50);
  const adminBeforeEarly = lamports(book, admin);
  const early = client.methods.crank().accounts({
    genesis: genesis.address,
    admin,
    systemProgram: anchor.SYSTEM_PROGRAM_ID,
  }).signers([]).rpc();
  assert.equal(early.ok, false);
  assert.equal(early.reason, 'time');
  assert.equal(client.account.genesis.fetch(genesis.address).cranked, false);
  assert.equal(lamports(book, admin), adminBeforeEarly);
  assert.equal(chain.getLaunch(book, genesis.address).data.launch.status, 'live');

  chain.setTime(book, 100);
  assert.equal(chain.getLaunch(book, genesis.address).data.launch.status, 'ended');
  const adminBefore = lamports(book, admin);
  const cranked = client.methods.crank().accounts({
    genesis: genesis.address,
    admin,
    systemProgram: anchor.SYSTEM_PROGRAM_ID,
  }).signers([]).rpc();
  assert.equal(cranked.ok, true);
  assert.equal(lamports(book, midway.bucket), bucketRent);
  assert.equal(lamports(book, admin), adminBefore + 90n);
  assert.equal(client.account.genesis.fetch(genesis.address).cranked, true);
  assert.equal(chain.getLaunch(book, genesis.address).data.launch.status, 'graduated');
  console.log('crank collected 90');

  chain.setTime(book, 101);
  const bucketToken = pda([
    Buffer.from('token'),
    bytes(baseMint),
    bytes(midway.bucket),
  ], assets.ASSET_PROGRAM_ID);
  const aliceToken = pda([Buffer.from('token'), bytes(baseMint), bytes(alice)], assets.ASSET_PROGRAM_ID);
  const bobToken = pda([Buffer.from('token'), bytes(baseMint), bytes(bob)], assets.ASSET_PROGRAM_ID);
  function claimAccounts(user) {
    return {
      user,
      genesis: genesis.address,
      systemProgram: anchor.SYSTEM_PROGRAM_ID,
    };
  }
  const aliceClaim = client.methods.claim().accounts(claimAccounts(alice)).signers([alice]).rpc();
  assert.equal(aliceClaim.ok, true);
  assert.equal(client.account.tokenAccount.fetch(aliceToken.address).amount, 222n);
  console.log('claim alice 222');

  const revoked = client.methods.revoke().accounts({
    admin,
    genesis: genesis.address,
    mint: baseMint,
  }).signers([admin]).rpc();
  assert.equal(revoked.ok, true);
  assert.equal(client.account.assetMint.fetch(baseMint).revoked, true);
  assert.equal(client.account.assetMint.fetch(baseMint).mintAuthority, anchor.ZERO_PUBKEY);
  assert.equal(chain.getLaunch(book, genesis.address).data.launch.status, 'ended');

  const bobClaim = client.methods.claim().accounts(claimAccounts(bob)).signers([bob]).rpc();
  assert.equal(bobClaim.ok, true);
  assert.equal(client.account.tokenAccount.fetch(bobToken.address).amount, 777n);
  assert.equal(client.account.tokenAccount.fetch(bucketToken.address).amount, 1n);
  console.log('claim bob 777 dust 1');

  const second = client.methods.claim().accounts(claimAccounts(alice)).signers([alice]).rpc();
  assert.equal(second.ok, false);
  assert.equal(second.reason, 'claimed');
  assert.equal(client.account.tokenAccount.fetch(aliceToken.address).amount, 222n);

  const minted = client.methods.mintTo(1n).accounts({
    mint: baseMint,
    destination: aliceToken.address,
    authority: admin,
  }).signers([admin]).rpc();
  assert.equal(minted.ok, false);
  assert.equal(minted.reason, 'revoked');
  assert.equal(client.account.assetMint.fetch(baseMint).supply, 1000n);
  assert.equal(client.account.tokenAccount.fetch(aliceToken.address).amount, 222n);

  const listed = chain.listLaunches(book);
  assert.equal(listed.length, 2);
  assert.ok(listed.some(entry => entry.launch.address === genesis.address && entry.launch.status === 'ended'));
  assert.ok(listed.some(entry => entry.launch.address === later.address && entry.launch.status === 'upcoming'));
});

test('validator config names the asset program and the preloaded clawd programs', () => {
  const config = chain.validatorConfig();
  assert.equal(config.killRunningValidators, false);
  assert.equal(config.jsonRpcUrl, 'http://127.0.0.1:18899');
  assert.equal(config.commitment, 'confirmed');
  assert.equal(config.relay.enabled, false);
  assert.equal(config.storage.enabled, false);
  const ids = config.programs.map(entry => entry.programId);
  assert.ok(ids.includes(assets.ASSET_PROGRAM_ID));
  assert.ok(ids.includes('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s'));
  assert.ok(ids.includes('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'));
  assert.ok(ids.includes('CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d'));
  assert.ok(ids.includes('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'));
  assert.equal(config.programs[0].deployPath, 'chain/asset-program.js');
  assert.equal(chain.validatorConfig({ rpc: 'http://127.0.0.1:18999' }).jsonRpcUrl, 'http://127.0.0.1:18999');
});

test('chain exports keep the market fund distinct from the anchor fund', () => {
  assert.equal(chain.fund, market.fund);
  assert.equal(chain.fundChain, anchor.fundChain);
  assert.equal(chain.createChain, anchor.createChain);
  assert.equal(chain.invoke, anchor.invoke);
  assert.equal(chain.findPda, anchor.findPda);
  assert.equal(chain.createClient, anchor.createClient);
  assert.equal(chain.assetProgram, assets.program);
  assert.equal(chain.createAssetClient, assets.createAssetClient);
  assert.equal(chain.getLaunch, assets.getLaunch);
  assert.equal(chain.listLaunches, assets.listLaunches);
  assert.equal(chain.createVault, vault.createVault);
  assert.equal(chain.lock, vault.lock);
  assert.equal(vault.PUMP_MINT, PUMP);
});
