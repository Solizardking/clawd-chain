/**
 * End-to-end demo of clawd_money on Clawd Chain.
 * Flow: init → register reporter → post price → aggregate →
 *       fund profit pool → flash-mint → profitable transfer → repay+tax →
 *       (legacy PDA lock removed — see demo-market.mjs for tenor AMM).
 * For lock → sell → buy → maturity check: node scripts/demo-market.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  Connection, Keypair, PublicKey, SystemProgram, Transaction,
  TransactionInstruction, SYSVAR_CLOCK_PUBKEY, SYSVAR_INSTRUCTIONS_PUBKEY,
  sendAndConfirmTransaction, LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID, MINT_SIZE, ACCOUNT_SIZE,
  getMinimumBalanceForRentExemptMint, getMinimumBalanceForRentExemptAccount,
  createInitializeMint2Instruction, createInitializeAccountInstruction,
  createMintToInstruction, createTransferInstruction, getAccount,
  createAssociatedTokenAccountInstruction, getAssociatedTokenAddressSync,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from '@solana/spl-token';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const RPC = process.env.CLAWCHAIN_RPC || 'https://rpc.clawdchain.trade';
const PROGRAM_ID = new PublicKey(
  fs.readFileSync(path.join(ROOT, 'PROGRAM_ID.txt'), 'utf8').trim()
);
const EXPLORER = 'https://explorer.clawdchain.trade/tx/';

function loadKp(p) {
  const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

const u8 = (n) => Buffer.from([n]);
const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };

const Ix = {
  init: (tax, quorum, haircut, liq, maxAge) =>
    Buffer.concat([u8(0), u16(tax), u16(quorum), u16(haircut), u16(liq), u64(maxAge)]),
  registerReporter: (weight) => Buffer.concat([u8(1), u64(weight)]),
  postPrice: (price) => Buffer.concat([u8(2), u64(price)]),
  aggregate: () => u8(3),
  flashMint: (amount) => Buffer.concat([u8(4), u64(amount)]),
  repay: () => u8(5),
  depositMint: (coll, mintAmt) => Buffer.concat([u8(6), u64(coll), u64(mintAmt)]),
  lock: (tenorIdx, lamports) => Buffer.concat([u8(8), u8(tenorIdx), u64(lamports)]),
};

function pda(seeds) {
  return PublicKey.findProgramAddressSync(seeds, PROGRAM_ID);
}

async function send(conn, payer, ixs, label) {
  const tx = new Transaction().add(...ixs);
  const sig = await sendAndConfirmTransaction(conn, tx, [payer], {
    commitment: 'confirmed',
    skipPreflight: false,
  });
  console.log(`${label}: ${EXPLORER}${sig}`);
  return sig;
}

async function sendMulti(conn, signers, ixs, label) {
  const tx = new Transaction().add(...ixs);
  const sig = await sendAndConfirmTransaction(conn, tx, signers, {
    commitment: 'confirmed',
  });
  console.log(`${label}: ${EXPLORER}${sig}`);
  return sig;
}

async function main() {
  const conn = new Connection(RPC, 'confirmed');
  const payer = loadKp(path.join(ROOT, '.keys/payer.json'));
  console.log('RPC', RPC);
  console.log('program', PROGRAM_ID.toBase58());
  console.log('payer', payer.publicKey.toBase58());
  console.log('balance', await conn.getBalance(payer.publicKey) / LAMPORTS_PER_SOL, 'SOL');

  const [config] = pda([Buffer.from('config')]);
  const [oracle] = pda([Buffer.from('oracle')]);
  const [csol] = pda([Buffer.from('csol')]);
  const [treasury] = pda([Buffer.from('treasury')]);
  const [cvault] = pda([Buffer.from('cvault')]);
  const [stakeVault] = pda([Buffer.from('stakevault')]);
  const [loan] = pda([Buffer.from('loan'), payer.publicKey.toBuffer()]);

  const sigs = {};
  const statePath = path.join(ROOT, 'demo-state.json');
  let state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : {};

  // --- Create collateral mint (once) ---
  let collMint;
  if (state.collMint) {
    collMint = new PublicKey(state.collMint);
    console.log('reuse coll mint', collMint.toBase58());
  } else {
    const mintKp = Keypair.generate();
    collMint = mintKp.publicKey;
    const lamports = await getMinimumBalanceForRentExemptMint(conn);
    sigs.createCollMint = await sendMulti(conn, [payer, mintKp], [
      SystemProgram.createAccount({
        fromPubkey: payer.publicKey,
        newAccountPubkey: collMint,
        lamports,
        space: MINT_SIZE,
        programId: TOKEN_PROGRAM_ID,
      }),
      createInitializeMint2Instruction(collMint, 9, payer.publicKey, null),
    ], 'create coll mint');
    state.collMint = collMint.toBase58();
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
  }

  // --- Init (skip if config exists) ---
  const cfgInfo = await conn.getAccountInfo(config);
  if (!cfgInfo) {
    sigs.init = await send(conn, payer, [
      new TransactionInstruction({
        programId: PROGRAM_ID,
        keys: [
          { pubkey: payer.publicKey, isSigner: true, isWritable: true },
          { pubkey: config, isSigner: false, isWritable: true },
          { pubkey: oracle, isSigner: false, isWritable: true },
          { pubkey: csol, isSigner: false, isWritable: true },
          { pubkey: treasury, isSigner: false, isWritable: true },
          { pubkey: collMint, isSigner: false, isWritable: false },
          { pubkey: cvault, isSigner: false, isWritable: true },
          { pubkey: stakeVault, isSigner: false, isWritable: true },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
          { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        ],
        data: Ix.init(
          1000,   // 10% profit tax
          5000,   // 50% quorum
          1000,   // 10% haircut
          9000,   // liquidate below 90% collateralization
          10_000, // max price age (slots)
        ),
      }),
    ], 'init');
  } else {
    console.log('config already initialized');
  }

  // --- Register reporter (idempotent-ish: may fail if already registered) ---
  const voteDummy = SystemProgram.programId; // not a vote acct → use supplied weight
  try {
    sigs.register = await send(conn, payer, [
      new TransactionInstruction({
        programId: PROGRAM_ID,
        keys: [
          { pubkey: payer.publicKey, isSigner: true, isWritable: false },
          { pubkey: config, isSigner: false, isWritable: false },
          { pubkey: oracle, isSigner: false, isWritable: true },
          { pubkey: payer.publicKey, isSigner: false, isWritable: false },
          { pubkey: voteDummy, isSigner: false, isWritable: false },
        ],
        data: Ix.registerReporter(1_000_000_000_000n), // 100% weight for single reporter
      }),
    ], 'register reporter');
  } catch (e) {
    console.log('register skipped:', e.message?.split('\n')[0]);
  }

  // --- Post price + aggregate ---
  // price scale: 1e9 = 1 cSOL per 1 collateral unit
  const PRICE = 1_000_000_000n;
  sigs.postPrice = await send(conn, payer, [
    new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: payer.publicKey, isSigner: true, isWritable: false },
        { pubkey: oracle, isSigner: false, isWritable: true },
      ],
      data: Ix.postPrice(PRICE),
    }),
  ], 'post price');

  sigs.aggregate = await send(conn, payer, [
    new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: config, isSigner: false, isWritable: false },
        { pubkey: oracle, isSigner: false, isWritable: true },
      ],
      data: Ix.aggregate(),
    }),
  ], 'aggregate');

  // --- ATAs / token accounts for payer cSOL + collateral ---
  const userCsol = getAssociatedTokenAddressSync(csol, payer.publicKey);
  const userColl = getAssociatedTokenAddressSync(collMint, payer.publicKey);

  const ixsSetup = [];
  if (!(await conn.getAccountInfo(userCsol))) {
    ixsSetup.push(createAssociatedTokenAccountInstruction(
      payer.publicKey, userCsol, payer.publicKey, csol,
    ));
  }
  if (!(await conn.getAccountInfo(userColl))) {
    ixsSetup.push(createAssociatedTokenAccountInstruction(
      payer.publicKey, userColl, payer.publicKey, collMint,
    ));
  }
  if (ixsSetup.length) {
    sigs.setupAtas = await send(conn, payer, ixsSetup, 'create ATAs');
  }

  // Mint collateral to user for DepositMint (profit source) + later
  sigs.mintColl = await send(conn, payer, [
    createMintToInstruction(collMint, userColl, payer.publicKey, 10_000_000_000n), // 10 coll
  ], 'mint collateral');

  // DepositMint → get 5 cSOL into user ATA as the "profit pool" we'll feed the flash borrower
  // max mint = 10e9 * 1e9 / 1e9 * 0.9 = 9e9; take 5e9
  sigs.depositMint = await send(conn, payer, [
    new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: config, isSigner: false, isWritable: false },
        { pubkey: oracle, isSigner: false, isWritable: false },
        { pubkey: pda([Buffer.from('pos'), payer.publicKey.toBuffer()])[0], isSigner: false, isWritable: true },
        { pubkey: csol, isSigner: false, isWritable: true },
        { pubkey: userCsol, isSigner: false, isWritable: true },
        { pubkey: userColl, isSigner: false, isWritable: true },
        { pubkey: cvault, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      ],
      data: Ix.depositMint(5_000_000_000n, 4_000_000_000n), // 5 coll → 4 cSOL
    }),
  ], 'deposit+mint (seed profit)');

  const beforeTreasury = (await getAccount(conn, treasury)).amount;
  const beforeUser = (await getAccount(conn, userCsol)).amount;
  console.log('before flash: user cSOL', beforeUser.toString(), 'treasury', beforeTreasury.toString());

  // Move 2 cSOL into a holding ATA owned by a temp key so FlashMint sees pre= (beforeUser-2e9)
  // Actually simpler: transfer 2 cSOL to a second wallet, flash with remaining, then transfer 2 back as profit.
  const holder = Keypair.generate();
  const holderCsol = getAssociatedTokenAddressSync(csol, holder.publicKey);
  // fund holder rent via payer creating ATA + transfer
  sigs.parkProfit = await send(conn, payer, [
    createAssociatedTokenAccountInstruction(
      payer.publicKey, holderCsol, holder.publicKey, csol,
    ),
    createTransferInstruction(userCsol, holderCsol, payer.publicKey, 2_000_000_000n),
  ], 'park 2 cSOL as profit');

  const preFlashUser = (await getAccount(conn, userCsol)).amount;
  console.log('pre-flash user cSOL', preFlashUser.toString());

  // --- THE FLASH TX: FlashMint → transfer profit in → Repay ---
  const FLASH = 1_000_000_000n; // 1 cSOL
  const flashIx = new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: config, isSigner: false, isWritable: false },
      { pubkey: loan, isSigner: false, isWritable: true },
      { pubkey: csol, isSigner: false, isWritable: true },
      { pubkey: userCsol, isSigner: false, isWritable: true },
      { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: Ix.flashMint(FLASH),
  });
  const profitIx = createTransferInstruction(
    holderCsol, userCsol, holder.publicKey, 2_000_000_000n,
  );
  const repayIx = new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: config, isSigner: false, isWritable: true },
      { pubkey: loan, isSigner: false, isWritable: true },
      { pubkey: csol, isSigner: false, isWritable: true },
      { pubkey: userCsol, isSigner: false, isWritable: true },
      { pubkey: treasury, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: Ix.repay(),
  });

  sigs.flash = await sendMulti(conn, [payer, holder], [flashIx, profitIx, repayIx], 'flash+profit+repay');

  const afterTreasury = (await getAccount(conn, treasury)).amount;
  const afterUser = (await getAccount(conn, userCsol)).amount;
  const tax = afterTreasury - beforeTreasury;
  console.log('after flash: user cSOL', afterUser.toString(), 'treasury', afterTreasury.toString());
  console.log('tax collected (cSOL base units):', tax.toString(),
    `(expected ~${Number(2_000_000_000n * 1000n / 10000n)} at 10% of 2 cSOL profit)`);

  // Lock/market flow lives in demo-market.mjs

  const out = {
    programId: PROGRAM_ID.toBase58(),
    collMint: collMint.toBase58(),
    config: config.toBase58(),
    oracle: oracle.toBase58(),
    csolMint: csol.toBase58(),
    treasury: treasury.toBase58(),
    stakeVault: stakeVault.toBase58(),
    taxCollected: tax.toString(),
    treasuryAfter: afterTreasury.toString(),
    signatures: sigs,
    explorer: Object.fromEntries(
      Object.entries(sigs).map(([k, v]) => [k, EXPLORER + v])
    ),
  };
  fs.writeFileSync(path.join(ROOT, 'demo-result.json'), JSON.stringify(out, null, 2));
  console.log('\n=== DEMO OK ===');
  console.log(JSON.stringify(out.explorer, null, 2));
}

main().catch((e) => {
  console.error('DEMO FAILED', e);
  process.exit(1);
});
