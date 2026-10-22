// Clawd asset program: fungible metadata, CLAWD transfers, hybrid swaps, and
// launch pools. It is defined only through the in-memory Anchor runtime.
// Quote lamports are CLAWD. Uri numbers walk [minUri, maxUri) so a swap cannot
// mint the same receipt twice.
const anchor = require('./anchor');

const ASSET_PROGRAM_ID = 'FexLarE252rpUrvWNogS8JVFJTfuxNKpvbuG4Mhe42NQ';
const { SYSTEM_PROGRAM_ID, ZERO_PUBKEY, fail, findPda, pubkeyBytes, readAccount, createClient, rentExempt } = anchor;

const SPACE = {
  mint: 128,
  token: 128,
  metadata: 400,
  deposit: 64,
  genesis: 512,
  bucket: 64,
  unlocked: 96,
  escrow: 256,
  receipt: 96,
  newAccount: 16,
};

const PRELOADED = [
  ['mpl-core', 'CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d'],
  ['candy-machine', 'CMACYFENjoBMHzapRXyo1JZkVS6EtaDDzkjMrmQLvr4J'],
  ['candy-guard', 'CMAGAKJ67e9hRZgfC5SFTbZH8MgEmtqazKXjmkaJjWTJ'],
  ['agent-identity', '1DREGFgysWYxLnRnKQnwrxnJQeSMk2HmGaC6whw2B2p'],
  ['agent-tools', 'TLREGni9ZEyGC3vnPZtqUh95xQ8oPqJSvNjvB7FGK8S'],
  ['genesis', 'GNS1S5J5AspKXgpjz6SvKL66kPaKWAhaGRhCqPRxii2B'],
  ['token-metadata', 'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s'],
  ['spl-token', 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'],
  ['token-2022', 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'],
  ['wrapped-sol', 'So11111111111111111111111111111111111111112'],
];

function text(value, min, max, reason) {
  if (typeof value !== 'string' || value.length < min || value.length > max) fail(reason);
}

function bps(value) {
  if (!Number.isInteger(value) || value < 0 || value > 10000) fail('args');
}

function systemMeta() {
  return { name: 'systemProgram', address: SYSTEM_PROGRAM_ID, executable: true };
}

function launchStatus(genesis, now) {
  if (genesis.revoked) return 'ended';
  if (genesis.cranked) return 'graduated';
  if (now < genesis.depositStart) return 'upcoming';
  if (now >= genesis.depositEnd) return 'ended';
  return 'live';
}

const program = anchor.defineProgram({
  id: ASSET_PROGRAM_ID,
  name: 'clawd_asset',
  accounts: {
    NewAccount: { fields: [{ name: 'data', type: 'u64' }] },
    Counter: { fields: [{ name: 'hits', type: 'u64' }] },
    AssetMint: {
      fields: [
        { name: 'mintAuthority', type: 'pubkey' },
        { name: 'freezeAuthority', type: 'pubkey' },
        { name: 'supply', type: 'u64' },
        { name: 'decimals', type: 'u8' },
        { name: 'revoked', type: 'bool' },
      ],
    },
    TokenAccount: {
      fields: [
        { name: 'mint', type: 'pubkey' },
        { name: 'owner', type: 'pubkey' },
        { name: 'amount', type: 'u64' },
        { name: 'frozen', type: 'bool' },
      ],
    },
    AssetMetadata: {
      fields: [
        { name: 'updateAuthority', type: 'pubkey' },
        { name: 'mint', type: 'pubkey' },
        { name: 'name', type: 'string' },
        { name: 'symbol', type: 'string' },
        { name: 'uri', type: 'string' },
        { name: 'sellerFeeBasisPoints', type: 'u16' },
        { name: 'tokenStandard', type: 'u8' },
        { name: 'isMutable', type: 'bool' },
      ],
    },
    Deposit: {
      fields: [
        { name: 'user', type: 'pubkey' },
        { name: 'amount', type: 'u64' },
        { name: 'claimed', type: 'bool' },
      ],
    },
    Genesis: {
      fields: [
        { name: 'admin', type: 'pubkey' },
        { name: 'baseMint', type: 'pubkey' },
        { name: 'bucket', type: 'pubkey' },
        { name: 'unlocked', type: 'pubkey' },
        { name: 'depositStart', type: 'u64' },
        { name: 'depositEnd', type: 'u64' },
        { name: 'claimStart', type: 'u64' },
        { name: 'totalSupply', type: 'u64' },
        { name: 'deposited', type: 'u64' },
        { name: 'clawdCollected', type: 'u64' },
        { name: 'cranked', type: 'bool' },
        { name: 'revoked', type: 'bool' },
      ],
    },
    LaunchBucket: { fields: [{ name: 'genesis', type: 'pubkey' }] },
    Unlocked: {
      fields: [
        { name: 'recipient', type: 'pubkey' },
        { name: 'genesis', type: 'pubkey' },
      ],
    },
    HybridEscrow: {
      fields: [
        { name: 'collection', type: 'pubkey' },
        { name: 'authority', type: 'pubkey' },
        { name: 'tokenAccount', type: 'pubkey' },
        { name: 'feeBps', type: 'u16' },
        { name: 'tokenPerSwap', type: 'u64' },
        { name: 'minUri', type: 'u64' },
        { name: 'maxUri', type: 'u64' },
        { name: 'nextUri', type: 'u64' },
        { name: 'tokenReserve', type: 'u64' },
      ],
    },
    NftReceipt: {
      fields: [
        { name: 'owner', type: 'pubkey' },
        { name: 'collection', type: 'pubkey' },
        { name: 'uri', type: 'u64' },
        { name: 'burned', type: 'bool' },
      ],
    },
  },
  instructions: [
    {
      name: 'initialize',
      args: [{ name: 'data', type: 'u64' }],
      accounts: [
        { name: 'newAccount', type: 'NewAccount', init: { space: SPACE.newAccount, payer: 'signer' } },
        { name: 'signer', signer: true, mut: true },
        systemMeta(),
      ],
      handler(ctx, { data }) {
        ctx.accounts.newAccount.data = data;
        ctx.log(`Changed data to: ${data}!`);
      },
    },
    {
      name: 'increment',
      args: [],
      accounts: [{ name: 'counter', type: 'NewAccount', mut: true }],
      handler(ctx) {
        ctx.accounts.counter.data = ctx.accounts.counter.data + 1n;
      },
    },
    {
      name: 'createFungible',
      args: [
        { name: 'name', type: 'string' },
        { name: 'symbol', type: 'string' },
        { name: 'uri', type: 'string' },
        { name: 'decimals', type: 'u8' },
        { name: 'supply', type: 'u64' },
        { name: 'sellerFeeBasisPoints', type: 'u16' },
      ],
      accounts: [
        { name: 'payer', signer: true, mut: true },
        { name: 'mint', type: 'AssetMint', signer: true, init: { space: SPACE.mint, payer: 'payer' } },
        {
          name: 'metadata',
          type: 'AssetMetadata',
          init: { space: SPACE.metadata, payer: 'payer' },
          seeds: ['metadata', { program: true }, { account: 'mint' }],
        },
        {
          name: 'token',
          type: 'TokenAccount',
          init: { space: SPACE.token, payer: 'payer' },
          seeds: ['token', { account: 'mint' }, { account: 'payer' }],
        },
        systemMeta(),
      ],
      handler(ctx, args) {
        writeFungible(ctx, args);
      },
    },
    {
      name: 'initTokenAccount',
      args: [],
      accounts: [
        { name: 'payer', signer: true, mut: true },
        { name: 'mint', type: 'AssetMint' },
        { name: 'owner' },
        {
          name: 'token',
          type: 'TokenAccount',
          init: { space: SPACE.token, payer: 'payer' },
          seeds: ['token', { account: 'mint' }, { account: 'owner' }],
        },
        systemMeta(),
      ],
      handler(ctx) {
        const token = ctx.accounts.token;
        token.mint = ctx.accounts.mint.key();
        token.owner = ctx.accounts.owner.key();
        token.amount = 0n;
        token.frozen = false;
      },
    },
    {
      name: 'transfer',
      args: [{ name: 'amount', type: 'u64' }],
      accounts: [
        { name: 'authority', signer: true },
        { name: 'source', type: 'TokenAccount', mut: true },
        { name: 'destination', type: 'TokenAccount', mut: true },
      ],
      handler(ctx, { amount }) {
        moveTokens(ctx.accounts.authority.key(), ctx.accounts.source, ctx.accounts.destination, amount);
      },
    },
    {
      name: 'updateMetadata',
      args: [
        { name: 'name', type: 'string' },
        { name: 'symbol', type: 'string' },
        { name: 'uri', type: 'string' },
      ],
      accounts: [
        { name: 'authority', signer: true },
        { name: 'metadata', type: 'AssetMetadata', mut: true },
      ],
      handler(ctx, args) {
        const metadata = ctx.accounts.metadata;
        if (!metadata.isMutable) fail('mutable');
        if (metadata.updateAuthority !== ctx.accounts.authority.key()) fail('owner');
        text(args.name, 1, 32, 'name');
        text(args.symbol, 1, 10, 'symbol');
        text(args.uri, 1, 200, 'uri');
        metadata.name = args.name;
        metadata.symbol = args.symbol;
        metadata.uri = args.uri;
      },
    },
    {
      name: 'freezeMetadata',
      args: [],
      accounts: [
        { name: 'authority', signer: true },
        { name: 'metadata', type: 'AssetMetadata', mut: true },
      ],
      handler(ctx) {
        const metadata = ctx.accounts.metadata;
        if (!metadata.isMutable) fail('mutable');
        if (metadata.updateAuthority !== ctx.accounts.authority.key()) fail('owner');
        metadata.isMutable = false;
      },
    },
    {
      name: 'freeze',
      args: [],
      accounts: [
        { name: 'authority', signer: true },
        { name: 'mint', type: 'AssetMint' },
        { name: 'token', type: 'TokenAccount', mut: true },
      ],
      handler(ctx) {
        setFrozen(ctx, true);
      },
    },
    {
      name: 'thaw',
      args: [],
      accounts: [
        { name: 'authority', signer: true },
        { name: 'mint', type: 'AssetMint' },
        { name: 'token', type: 'TokenAccount', mut: true },
      ],
      handler(ctx) {
        setFrozen(ctx, false);
      },
    },
    {
      name: 'mintTo',
      args: [{ name: 'amount', type: 'u64' }],
      accounts: [
        { name: 'mint', type: 'AssetMint', mut: true },
        { name: 'destination', type: 'TokenAccount', mut: true },
        { name: 'authority', signer: true },
      ],
      handler(ctx, { amount }) {
        const mint = ctx.accounts.mint;
        if (mint.revoked || mint.mintAuthority === ZERO_PUBKEY) fail('revoked');
        if (mint.mintAuthority !== ctx.accounts.authority.key()) fail('owner');
        if (amount <= 0n) fail('amount');
        const destination = ctx.accounts.destination;
        if (destination.mint !== mint.key()) fail('account');
        if (destination.frozen) fail('frozen');
        mint.supply = mint.supply + amount;
        destination.amount = destination.amount + amount;
      },
    },
    {
      name: 'clawdTransfer',
      args: [{ name: 'amount', type: 'u64' }],
      accounts: [
        { name: 'from', signer: true, mut: true },
        { name: 'to', mut: true },
        systemMeta(),
      ],
      handler(ctx, { amount }) {
        ctx.log('clawd transfer');
        ctx.cpi(anchor.systemProgram, 'transfer', {
          from: ctx.accounts.from.key(),
          to: ctx.accounts.to.key(),
        }, { amount }, []);
      },
    },
    {
      name: 'clawdTransferPda',
      args: [{ name: 'amount', type: 'u64' }],
      accounts: [
        { name: 'pda', mut: true, seeds: ['pda', { account: 'recipient' }] },
        { name: 'recipient', mut: true },
        systemMeta(),
      ],
      handler(ctx, { amount }) {
        ctx.cpi(anchor.systemProgram, 'transfer', {
          from: ctx.accounts.pda.key(),
          to: ctx.accounts.recipient.key(),
        }, { amount }, [[
          Buffer.from('pda'),
          pubkeyBytes(ctx.accounts.recipient.key()),
          Buffer.from([ctx.bumps.pda]),
        ]]);
      },
    },
    {
      name: 'createHybrid',
      args: [
        { name: 'feeBps', type: 'u16' },
        { name: 'tokenPerSwap', type: 'u64' },
        { name: 'minUri', type: 'u64' },
        { name: 'maxUri', type: 'u64' },
        { name: 'amount', type: 'u64' },
      ],
      accounts: [
        { name: 'payer', signer: true, mut: true },
        { name: 'collection', type: 'AssetMint' },
        { name: 'source', type: 'TokenAccount', mut: true },
        {
          name: 'escrow',
          type: 'HybridEscrow',
          init: { space: SPACE.escrow, payer: 'payer' },
          seeds: ['hybrid', { account: 'collection' }],
        },
        {
          name: 'escrowToken',
          type: 'TokenAccount',
          init: { space: SPACE.token, payer: 'payer' },
          seeds: ['token', { account: 'collection' }, { account: 'escrow' }],
        },
        systemMeta(),
      ],
      handler(ctx, args) {
        bps(args.feeBps);
        if (args.tokenPerSwap <= 0n || args.amount <= 0n) fail('amount');
        if (args.minUri > args.maxUri) fail('args');
        const source = ctx.accounts.source;
        if (source.owner !== ctx.accounts.payer.key()) fail('owner');
        if (source.mint !== ctx.accounts.collection.key()) fail('account');
        if (source.frozen) fail('frozen');
        if (args.amount > source.amount) fail('balance');
        source.amount = source.amount - args.amount;
        const escrow = ctx.accounts.escrow;
        const escrowToken = ctx.accounts.escrowToken;
        escrow.collection = ctx.accounts.collection.key();
        escrow.authority = ctx.accounts.payer.key();
        escrow.tokenAccount = escrowToken.key();
        escrow.feeBps = args.feeBps;
        escrow.tokenPerSwap = args.tokenPerSwap;
        escrow.minUri = args.minUri;
        escrow.maxUri = args.maxUri;
        escrow.nextUri = args.minUri;
        escrow.tokenReserve = args.amount;
        escrowToken.mint = ctx.accounts.collection.key();
        escrowToken.owner = escrow.key();
        escrowToken.amount = args.amount;
        escrowToken.frozen = false;
      },
    },
    {
      name: 'swapTokenToNft',
      args: [],
      accounts: [
        { name: 'user', signer: true, mut: true },
        { name: 'userToken', type: 'TokenAccount', mut: true },
        { name: 'escrow', type: 'HybridEscrow', mut: true },
        { name: 'escrowToken', type: 'TokenAccount', mut: true },
        {
          name: 'receipt',
          type: 'NftReceipt',
          init: { space: SPACE.receipt, payer: 'user' },
          seeds: [
            'nft',
            { account: 'escrow', field: 'collection', type: 'pubkey' },
            { account: 'escrow', field: 'nextUri', type: 'u64' },
          ],
        },
        systemMeta(),
      ],
      handler(ctx) {
        const escrow = ctx.accounts.escrow;
        if (escrow.nextUri >= escrow.maxUri) fail('args');
        const userToken = ctx.accounts.userToken;
        const escrowToken = ctx.accounts.escrowToken;
        if (userToken.owner !== ctx.accounts.user.key()) fail('owner');
        if (userToken.mint !== escrow.collection || escrowToken.mint !== escrow.collection) fail('account');
        if (userToken.frozen || escrowToken.frozen) fail('frozen');
        if (userToken.amount < escrow.tokenPerSwap) fail('balance');
        userToken.amount = userToken.amount - escrow.tokenPerSwap;
        escrowToken.amount = escrowToken.amount + escrow.tokenPerSwap;
        const receipt = ctx.accounts.receipt;
        receipt.owner = ctx.accounts.user.key();
        receipt.collection = escrow.collection;
        receipt.uri = escrow.nextUri;
        receipt.burned = false;
        escrow.nextUri = escrow.nextUri + 1n;
      },
    },
    {
      name: 'swapNftToToken',
      args: [],
      accounts: [
        { name: 'user', signer: true },
        { name: 'userToken', type: 'TokenAccount', mut: true },
        { name: 'escrow', type: 'HybridEscrow', mut: true },
        { name: 'escrowToken', type: 'TokenAccount', mut: true },
        { name: 'receipt', type: 'NftReceipt', mut: true },
      ],
      handler(ctx) {
        const escrow = ctx.accounts.escrow;
        const receipt = ctx.accounts.receipt;
        if (receipt.burned) fail('account');
        if (receipt.owner !== ctx.accounts.user.key()) fail('owner');
        if (receipt.collection !== escrow.collection) fail('account');
        const userToken = ctx.accounts.userToken;
        const escrowToken = ctx.accounts.escrowToken;
        if (userToken.owner !== ctx.accounts.user.key()) fail('owner');
        if (userToken.mint !== escrow.collection || escrowToken.mint !== escrow.collection) fail('account');
        if (userToken.frozen || escrowToken.frozen) fail('frozen');
        const net = escrow.tokenPerSwap * (10000n - BigInt(escrow.feeBps)) / 10000n;
        if (net <= 0n) fail('amount');
        if (escrowToken.amount < net) fail('balance');
        escrowToken.amount = escrowToken.amount - net;
        userToken.amount = userToken.amount + net;
        receipt.burned = true;
      },
    },
    {
      name: 'createLaunch',
      args: [
        { name: 'name', type: 'string' },
        { name: 'symbol', type: 'string' },
        { name: 'uri', type: 'string' },
        { name: 'decimals', type: 'u8' },
        { name: 'sellerFeeBasisPoints', type: 'u16' },
        { name: 'totalSupply', type: 'u64' },
        { name: 'depositStart', type: 'u64' },
        { name: 'depositEnd', type: 'u64' },
        { name: 'claimStart', type: 'u64' },
      ],
      accounts: [
        { name: 'payer', signer: true, mut: true },
        { name: 'baseMint', type: 'AssetMint', signer: true, init: { space: SPACE.mint, payer: 'payer' } },
        {
          name: 'metadata',
          type: 'AssetMetadata',
          init: { space: SPACE.metadata, payer: 'payer' },
          seeds: ['metadata', { program: true }, { account: 'baseMint' }],
        },
        {
          name: 'genesis',
          type: 'Genesis',
          init: { space: SPACE.genesis, payer: 'payer' },
          seeds: ['genesis', { account: 'baseMint' }],
        },
        {
          name: 'bucket',
          type: 'LaunchBucket',
          init: { space: SPACE.bucket, payer: 'payer' },
          seeds: ['launch_pool', { account: 'genesis' }],
        },
        {
          name: 'bucketToken',
          type: 'TokenAccount',
          init: { space: SPACE.token, payer: 'payer' },
          seeds: ['token', { account: 'baseMint' }, { account: 'bucket' }],
        },
        {
          name: 'unlocked',
          type: 'Unlocked',
          init: { space: SPACE.unlocked, payer: 'payer' },
          seeds: ['unlocked', { account: 'genesis' }],
        },
        systemMeta(),
      ],
      handler(ctx, args) {
        text(args.name, 1, 32, 'name');
        text(args.symbol, 1, 10, 'symbol');
        text(args.uri, 1, 200, 'uri');
        if (!Number.isInteger(args.decimals) || args.decimals < 0 || args.decimals > 9) fail('args');
        bps(args.sellerFeeBasisPoints);
        if (args.totalSupply <= 0n) fail('amount');
        if (args.depositEnd <= args.depositStart || args.claimStart < args.depositEnd) fail('time');
        const payer = ctx.accounts.payer.key();
        const mint = ctx.accounts.baseMint;
        mint.mintAuthority = payer;
        mint.freezeAuthority = payer;
        mint.supply = args.totalSupply;
        mint.decimals = args.decimals;
        mint.revoked = false;
        writeMetadata(ctx.accounts.metadata, mint.key(), payer, args);
        const genesis = ctx.accounts.genesis;
        const bucket = ctx.accounts.bucket;
        const unlocked = ctx.accounts.unlocked;
        genesis.admin = payer;
        genesis.baseMint = mint.key();
        genesis.bucket = bucket.key();
        genesis.unlocked = unlocked.key();
        genesis.depositStart = args.depositStart;
        genesis.depositEnd = args.depositEnd;
        genesis.claimStart = args.claimStart;
        genesis.totalSupply = args.totalSupply;
        genesis.deposited = 0n;
        genesis.clawdCollected = 0n;
        genesis.cranked = false;
        genesis.revoked = false;
        bucket.genesis = genesis.key();
        unlocked.recipient = payer;
        unlocked.genesis = genesis.key();
        const bucketToken = ctx.accounts.bucketToken;
        bucketToken.mint = mint.key();
        bucketToken.owner = bucket.key();
        bucketToken.amount = args.totalSupply;
        bucketToken.frozen = false;
      },
    },
    {
      name: 'deposit',
      args: [{ name: 'amount', type: 'u64' }],
      accounts: [
        { name: 'user', signer: true, mut: true },
        { name: 'genesis', type: 'Genesis', mut: true },
        { name: 'bucket', type: 'LaunchBucket', mut: true, seeds: ['launch_pool', { account: 'genesis' }] },
        {
          name: 'deposit',
          type: 'Deposit',
          initIfNeeded: { space: SPACE.deposit, payer: 'user' },
          seeds: ['deposit', { account: 'bucket' }, { account: 'user' }],
        },
        systemMeta(),
      ],
      handler(ctx, { amount }) {
        if (amount <= 0n) fail('amount');
        const genesis = ctx.accounts.genesis;
        if (ctx.now < genesis.depositStart || ctx.now >= genesis.depositEnd) fail('time');
        ctx.cpi(anchor.systemProgram, 'transfer', {
          from: ctx.accounts.user.key(),
          to: ctx.accounts.bucket.key(),
        }, { amount }, []);
        const deposit = ctx.accounts.deposit;
        const user = ctx.accounts.user.key();
        if (deposit.user === ZERO_PUBKEY) deposit.user = user;
        if (deposit.user !== user) fail('owner');
        if (deposit.claimed) fail('claimed');
        deposit.amount = deposit.amount + amount;
        genesis.deposited = genesis.deposited + amount;
        genesis.clawdCollected = genesis.clawdCollected + amount;
      },
    },
    {
      name: 'withdraw',
      args: [{ name: 'amount', type: 'u64' }],
      accounts: [
        { name: 'user', signer: true, mut: true },
        { name: 'genesis', type: 'Genesis', mut: true },
        { name: 'bucket', type: 'LaunchBucket', mut: true, seeds: ['launch_pool', { account: 'genesis' }] },
        {
          name: 'deposit',
          type: 'Deposit',
          mut: true,
          seeds: ['deposit', { account: 'bucket' }, { account: 'user' }],
        },
        systemMeta(),
      ],
      handler(ctx, { amount }) {
        if (amount <= 0n) fail('amount');
        const genesis = ctx.accounts.genesis;
        if (ctx.now >= genesis.depositEnd) fail('time');
        const deposit = ctx.accounts.deposit;
        if (deposit.user !== ctx.accounts.user.key()) fail('owner');
        if (deposit.claimed) fail('claimed');
        if (amount > deposit.amount) fail('balance');
        payFromBucket(ctx, ctx.accounts.user.key(), amount);
        deposit.amount = deposit.amount - amount;
        genesis.deposited = genesis.deposited - amount;
        genesis.clawdCollected = genesis.clawdCollected - amount;
      },
    },
    {
      name: 'crank',
      args: [],
      accounts: [
        { name: 'genesis', type: 'Genesis', mut: true },
        { name: 'bucket', type: 'LaunchBucket', mut: true, seeds: ['launch_pool', { account: 'genesis' }] },
        { name: 'admin', mut: true },
        systemMeta(),
      ],
      handler(ctx) {
        const genesis = ctx.accounts.genesis;
        if (ctx.now < genesis.depositEnd) fail('time');
        if (genesis.cranked) fail('args');
        if (ctx.accounts.admin.key() !== genesis.admin) fail('owner');
        // Collected CLAWD moves to the admin. Rent stays on the bucket.
        if (genesis.clawdCollected > 0n) payFromBucket(ctx, genesis.admin, genesis.clawdCollected);
        genesis.cranked = true;
      },
    },
    {
      name: 'claim',
      args: [],
      accounts: [
        { name: 'user', signer: true, mut: true },
        { name: 'genesis', type: 'Genesis', mut: true },
        { name: 'bucket', type: 'LaunchBucket', mut: true, seeds: ['launch_pool', { account: 'genesis' }] },
        {
          name: 'bucketToken',
          type: 'TokenAccount',
          mut: true,
          seeds: ['token', { account: 'genesis', field: 'baseMint', type: 'pubkey' }, { account: 'bucket' }],
        },
        {
          name: 'deposit',
          type: 'Deposit',
          mut: true,
          seeds: ['deposit', { account: 'bucket' }, { account: 'user' }],
        },
        {
          name: 'userToken',
          type: 'TokenAccount',
          initIfNeeded: { space: SPACE.token, payer: 'user' },
          seeds: ['token', { account: 'genesis', field: 'baseMint', type: 'pubkey' }, { account: 'user' }],
        },
        systemMeta(),
      ],
      handler(ctx) {
        const genesis = ctx.accounts.genesis;
        if (!genesis.cranked) fail('args');
        if (ctx.now < genesis.claimStart) fail('time');
        const deposit = ctx.accounts.deposit;
        if (deposit.user !== ctx.accounts.user.key()) fail('owner');
        if (deposit.claimed) fail('claimed');
        if (genesis.deposited === 0n || deposit.amount === 0n) fail('amount');
        const share = deposit.amount * genesis.totalSupply / genesis.deposited;
        if (share <= 0n) fail('amount');
        const bucketToken = ctx.accounts.bucketToken;
        if (bucketToken.amount < share) fail('balance');
        const userToken = ctx.accounts.userToken;
        if (userToken.mint === ZERO_PUBKEY) {
          userToken.mint = genesis.baseMint;
          userToken.owner = ctx.accounts.user.key();
          userToken.amount = 0n;
          userToken.frozen = false;
        }
        if (userToken.owner !== ctx.accounts.user.key()) fail('owner');
        if (userToken.mint !== genesis.baseMint) fail('account');
        if (userToken.frozen || bucketToken.frozen) fail('frozen');
        bucketToken.amount = bucketToken.amount - share;
        userToken.amount = userToken.amount + share;
        deposit.claimed = true;
      },
    },
    {
      name: 'revoke',
      args: [],
      accounts: [
        { name: 'admin', signer: true },
        { name: 'genesis', type: 'Genesis', mut: true },
        { name: 'mint', type: 'AssetMint', mut: true },
      ],
      handler(ctx) {
        const genesis = ctx.accounts.genesis;
        if (ctx.accounts.admin.key() !== genesis.admin) fail('owner');
        if (ctx.accounts.mint.key() !== genesis.baseMint) fail('account');
        ctx.accounts.mint.mintAuthority = ZERO_PUBKEY;
        ctx.accounts.mint.revoked = true;
        genesis.revoked = true;
      },
    },
  ],
});

function writeMetadata(metadata, mint, authority, args) {
  metadata.updateAuthority = authority;
  metadata.mint = mint;
  metadata.name = args.name;
  metadata.symbol = args.symbol;
  metadata.uri = args.uri;
  metadata.sellerFeeBasisPoints = args.sellerFeeBasisPoints;
  metadata.tokenStandard = args.decimals === 0 ? 2 : 1;
  metadata.isMutable = true;
}

function writeFungible(ctx, args) {
  text(args.name, 1, 32, 'name');
  text(args.symbol, 1, 10, 'symbol');
  text(args.uri, 1, 200, 'uri');
  if (!Number.isInteger(args.decimals) || args.decimals < 0 || args.decimals > 9) fail('args');
  bps(args.sellerFeeBasisPoints);
  if (args.supply <= 0n) fail('amount');
  const payer = ctx.accounts.payer.key();
  const mint = ctx.accounts.mint;
  mint.mintAuthority = payer;
  mint.freezeAuthority = payer;
  mint.supply = args.supply;
  mint.decimals = args.decimals;
  mint.revoked = false;
  writeMetadata(ctx.accounts.metadata, mint.key(), payer, args);
  const token = ctx.accounts.token;
  token.mint = mint.key();
  token.owner = payer;
  token.amount = args.supply;
  token.frozen = false;
}

function moveTokens(authority, source, destination, amount) {
  if (amount <= 0n) fail('amount');
  if (source.owner !== authority) fail('owner');
  if (source.mint !== destination.mint) fail('account');
  if (source.frozen || destination.frozen) fail('frozen');
  if (amount > source.amount) fail('balance');
  source.amount = source.amount - amount;
  destination.amount = destination.amount + amount;
}

function setFrozen(ctx, frozen) {
  const mint = ctx.accounts.mint;
  if (mint.freezeAuthority !== ctx.accounts.authority.key()) fail('owner');
  if (ctx.accounts.token.mint !== mint.key()) fail('account');
  ctx.accounts.token.frozen = frozen;
}

function payFromBucket(ctx, recipient, amount) {
  const rent = rentExempt(SPACE.bucket);
  if (ctx.accounts.bucket.lamports - amount < rent) fail('rent');
  ctx.cpi(anchor.systemProgram, 'transfer', {
    from: ctx.accounts.bucket.key(),
    to: recipient,
  }, { amount }, [[
    Buffer.from('launch_pool'),
    pubkeyBytes(ctx.accounts.genesis.key()),
    Buffer.from([ctx.bumps.bucket]),
  ]]);
}

function metadataAddress(mint) {
  return findPda([Buffer.from('metadata'), pubkeyBytes(program.id), pubkeyBytes(mint)], program.id).address;
}

function launchView(chain, address, genesis) {
  const mintRec = chain.accounts.get(genesis.baseMint);
  const mint = readAccount(program, 'AssetMint', mintRec);
  const metadata = readAccount(program, 'AssetMetadata', chain.accounts.get(metadataAddress(genesis.baseMint)));
  return {
    launch: {
      address,
      admin: genesis.admin,
      baseMint: genesis.baseMint,
      bucket: genesis.bucket,
      unlocked: genesis.unlocked,
      depositStart: genesis.depositStart,
      depositEnd: genesis.depositEnd,
      claimStart: genesis.claimStart,
      totalSupply: genesis.totalSupply,
      deposited: genesis.deposited,
      clawdCollected: genesis.clawdCollected,
      cranked: genesis.cranked,
      revoked: genesis.revoked,
      status: launchStatus(genesis, chain.now),
      mechanic: 'launchpoolV2',
      type: 'launchpool',
      launchPage: `https://clawdchain.trade/launch/${address}`,
    },
    baseToken: {
      address: genesis.baseMint,
      supply: mint ? mint.supply : 0n,
      decimals: mint ? mint.decimals : 0,
      mintAuthority: mint ? mint.mintAuthority : ZERO_PUBKEY,
      revoked: mint ? mint.revoked : false,
      name: metadata ? metadata.name : '',
      symbol: metadata ? metadata.symbol : '',
      uri: metadata ? metadata.uri : '',
    },
  };
}

function getLaunch(chain, genesisAddress) {
  const address = typeof genesisAddress === 'string' ? genesisAddress : null;
  const decoded = address ? readAccount(program, 'Genesis', chain.accounts.get(address)) : null;
  if (!decoded) return { error: { message: 'Launch not found' } };
  return { data: launchView(chain, address, decoded) };
}

function listLaunches(chain) {
  const launches = [];
  for (const rec of chain.accounts.values()) {
    const decoded = readAccount(program, 'Genesis', rec);
    if (decoded) launches.push(launchView(chain, rec.address, decoded));
  }
  return launches;
}

function validatorConfig({ rpc = 'http://127.0.0.1:18899' } = {}) {
  return {
    killRunningValidators: false,
    jsonRpcUrl: rpc,
    commitment: 'confirmed',
    relay: { enabled: false },
    storage: { enabled: false },
    programs: [
      { label: 'clawd-asset', programId: ASSET_PROGRAM_ID, deployPath: 'chain/asset-program.js' },
      ...PRELOADED.map(([label, programId]) => ({ label, programId, clone: true })),
    ],
    accounts: PRELOADED.map(([, programId]) => ({ address: programId, clone: true })),
  };
}

function createAssetClient(chain) {
  return createClient(chain, program);
}

module.exports = {
  ASSET_PROGRAM_ID,
  SPACE,
  program,
  createAssetClient,
  getLaunch,
  listLaunches,
  validatorConfig,
};
