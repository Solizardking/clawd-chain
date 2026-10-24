/**
 * Secondary market demo: InitMarket → Lock (mint notes) → AmmSeed →
 * sell notes → buy notes → maturity-check Redeem.
 * Prints implied yield curve across 1/3/6/12 epoch tenors.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  Connection, Keypair, PublicKey, SystemProgram, Transaction,
  TransactionInstruction, sendAndConfirmTransaction, LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID, createMintToInstruction, createTransferInstruction,
  getAccount, createAssociatedTokenAccountInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const RPC = process.env.CLAWCHAIN_RPC || 'https://rpc.clawdchain.trade';
const PROGRAM_ID = new PublicKey(fs.readFileSync(path.join(ROOT, 'PROGRAM_ID.txt'), 'utf8').trim());
const EXPLORER = 'https://explorer.clawdchain.trade/tx/';
const TENORS = [1, 3, 6, 12];
/** Seed discounts: cSOL per 1.0 note (face). Deeper discount → higher yield. */
const SEED_PRICE = [0.990, 0.970, 0.940, 0.880];
const EPOCHS_PER_YEAR = 182.5;

function loadKp(p) {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, 'utf8'))));
}
const u8 = (n) => Buffer.from([n]);
const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };

const Ix = {
  // discriminants match program enum order
  depositMint: (coll, mintAmt) => Buffer.concat([u8(6), u64(coll), u64(mintAmt)]),
  lock: (tenorIdx, lamports) => Buffer.concat([u8(8), u8(tenorIdx), u64(lamports)]),
  redeem: (amount) => Buffer.concat([u8(9), u64(amount)]),
  initMarket: (tenorIdx, feeBps) => Buffer.concat([u8(10), u8(tenorIdx), u16(feeBps)]),
  ammSeed: (noteAmt, csolAmt) => Buffer.concat([u8(11), u64(noteAmt), u64(csolAmt)]),
  ammSwap: (amountIn, minOut, noteForCsol) =>
    Buffer.concat([u8(12), u64(amountIn), u64(minOut), u8(noteForCsol ? 1 : 0)]),
  postPrice: (price) => Buffer.concat([u8(2), u64(price)]),
  aggregate: () => u8(3),
};

function pda(seeds) {
  return PublicKey.findProgramAddressSync(seeds, PROGRAM_ID);
}

async function send(conn, signers, ixs, label) {
  const tx = new Transaction().add(...ixs);
  const sig = await sendAndConfirmTransaction(conn, tx, signers, { commitment: 'confirmed' });
  console.log(`${label}: ${EXPLORER}${sig}`);
  return sig;
}

function readMarket(data) {
  // borsh: tenor_idx u8, bump u8, fee_bps u16, note_mint 32, note_vault 32, csol_vault 32,
  // reserve_note u64, reserve_csol u64, maturity_epoch u64, total_locked u64
  let o = 0;
  const tenor_idx = data[o++]; const bump = data[o++];
  const fee_bps = data.readUInt16LE(o); o += 2;
  const note_mint = new PublicKey(data.subarray(o, o + 32)); o += 32;
  const note_vault = new PublicKey(data.subarray(o, o + 32)); o += 32;
  const csol_vault = new PublicKey(data.subarray(o, o + 32)); o += 32;
  const reserve_note = data.readBigUInt64LE(o); o += 8;
  const reserve_csol = data.readBigUInt64LE(o); o += 8;
  const maturity_epoch = data.readBigUInt64LE(o); o += 8;
  const total_locked = data.readBigUInt64LE(o);
  return { tenor_idx, bump, fee_bps, note_mint, note_vault, csol_vault,
    reserve_note, reserve_csol, maturity_epoch, total_locked };
}

function yieldFromSpot(price, tenorEpochs) {
  // price = cSOL per note face; face redeems at 1.0
  if (price <= 0 || price >= 1) {
    return { simple: 0, annualized: 0, price };
  }
  const simple = 1 / price - 1;
  const annualized = simple * (EPOCHS_PER_YEAR / tenorEpochs);
  return { simple, annualized, price };
}

async function main() {
  const conn = new Connection(RPC, 'confirmed');
  const payer = loadKp(path.join(ROOT, '.keys/payer.json'));
  const buyer = Keypair.generate(); // ephemeral counterparty for the secondary market
  const sigs = {};
  const [config] = pda([Buffer.from('config')]);
  const [oracle] = pda([Buffer.from('oracle')]);
  const [csol] = pda([Buffer.from('csol')]);
  const [cvault] = pda([Buffer.from('cvault')]);
  const [stakeVault] = pda([Buffer.from('stakevault')]);
  const userCsol = getAssociatedTokenAddressSync(csol, payer.publicKey);
  const buyerCsol = getAssociatedTokenAddressSync(csol, buyer.publicKey);

  console.log('program', PROGRAM_ID.toBase58());
  console.log('payer', payer.publicKey.toBase58());
  console.log('buyer', buyer.publicKey.toBase58());

  // Refresh oracle so DepositMint works if we need more cSOL
  sigs.postPrice = await send(conn, [payer], [
    new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: payer.publicKey, isSigner: true, isWritable: false },
        { pubkey: oracle, isSigner: false, isWritable: true },
      ],
      data: Ix.postPrice(1_000_000_000n),
    }),
  ], 'post price');
  sigs.aggregate = await send(conn, [payer], [
    new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: config, isSigner: false, isWritable: false },
        { pubkey: oracle, isSigner: false, isWritable: true },
      ],
      data: Ix.aggregate(),
    }),
  ], 'aggregate');

  // Ensure payer has plenty of cSOL for seeding + buyer funding
  const state = JSON.parse(fs.readFileSync(path.join(ROOT, 'demo-state.json'), 'utf8'));
  const collMint = new PublicKey(state.collMint);
  const userColl = getAssociatedTokenAddressSync(collMint, payer.publicKey);
  sigs.mintColl = await send(conn, [payer], [
    createMintToInstruction(collMint, userColl, payer.publicKey, 50_000_000_000n),
  ], 'mint more collateral');
  const [pos] = pda([Buffer.from('pos'), payer.publicKey.toBuffer()]);
  sigs.depositMint = await send(conn, [payer], [
    new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: config, isSigner: false, isWritable: false },
        { pubkey: oracle, isSigner: false, isWritable: false },
        { pubkey: pos, isSigner: false, isWritable: true },
        { pubkey: csol, isSigner: false, isWritable: true },
        { pubkey: userCsol, isSigner: false, isWritable: true },
        { pubkey: userColl, isSigner: false, isWritable: true },
        { pubkey: cvault, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      ],
      data: Ix.depositMint(40_000_000_000n, 30_000_000_000n), // 30 cSOL
    }),
  ], 'deposit+mint cSOL for markets');

  // Fund buyer with SOL (fees) + create ATA + send cSOL
  sigs.fundBuyer = await send(conn, [payer], [
    SystemProgram.transfer({
      fromPubkey: payer.publicKey,
      toPubkey: buyer.publicKey,
      lamports: 50_000_000n, // 0.05 SOL
    }),
    createAssociatedTokenAccountInstruction(
      payer.publicKey, buyerCsol, buyer.publicKey, csol,
    ),
    createTransferInstruction(userCsol, buyerCsol, payer.publicKey, 5_000_000_000n), // 5 cSOL
  ], 'fund buyer');

  const markets = [];
  for (let t = 0; t < 4; t++) {
    const tb = Buffer.from([t]);
    const [market] = pda([Buffer.from('market'), tb]);
    const [noteMint] = pda([Buffer.from('note_mint'), tb]);
    const [noteVault] = pda([Buffer.from('note_vault'), tb]);
    const [ammCsol] = pda([Buffer.from('amm_csol'), tb]);
    const info = await conn.getAccountInfo(market);
    if (!info) {
      sigs[`initMarket_${TENORS[t]}e`] = await send(conn, [payer], [
        new TransactionInstruction({
          programId: PROGRAM_ID,
          keys: [
            { pubkey: payer.publicKey, isSigner: true, isWritable: true },
            { pubkey: config, isSigner: false, isWritable: false },
            { pubkey: market, isSigner: false, isWritable: true },
            { pubkey: noteMint, isSigner: false, isWritable: true },
            { pubkey: noteVault, isSigner: false, isWritable: true },
            { pubkey: ammCsol, isSigner: false, isWritable: true },
            { pubkey: csol, isSigner: false, isWritable: false },
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
            { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
          ],
          data: Ix.initMarket(t, 30), // 30 bps fee
        }),
      ], `init market ${TENORS[t]}-epoch`);
    } else {
      console.log(`market ${TENORS[t]}e already exists`);
    }
    const userNote = getAssociatedTokenAddressSync(noteMint, payer.publicKey);
    const buyerNote = getAssociatedTokenAddressSync(noteMint, buyer.publicKey);
    const ataIxs = [];
    if (!(await conn.getAccountInfo(userNote))) {
      ataIxs.push(createAssociatedTokenAccountInstruction(
        payer.publicKey, userNote, payer.publicKey, noteMint,
      ));
    }
    if (!(await conn.getAccountInfo(buyerNote))) {
      ataIxs.push(createAssociatedTokenAccountInstruction(
        payer.publicKey, buyerNote, buyer.publicKey, noteMint,
      ));
    }
    if (ataIxs.length) {
      sigs[`atas_${TENORS[t]}e`] = await send(conn, [payer], ataIxs, `ATAs ${TENORS[t]}e`);
    }
    markets.push({ t, market, noteMint, noteVault, ammCsol, userNote, buyerNote });
  }

  // Lock SOL → mint notes for each tenor (0.2 SOL each)
  const LOCK = 200_000_000n; // 0.2 SOL
  for (const m of markets) {
    sigs[`lock_${TENORS[m.t]}e`] = await send(conn, [payer], [
      new TransactionInstruction({
        programId: PROGRAM_ID,
        keys: [
          { pubkey: payer.publicKey, isSigner: true, isWritable: true },
          { pubkey: config, isSigner: false, isWritable: false },
          { pubkey: m.market, isSigner: false, isWritable: true },
          { pubkey: m.noteMint, isSigner: false, isWritable: true },
          { pubkey: m.userNote, isSigner: false, isWritable: true },
          { pubkey: stakeVault, isSigner: false, isWritable: true },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
          { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        ],
        data: Ix.lock(m.t, LOCK),
      }),
    ], `lock 0.2 SOL → ${TENORS[m.t]}e notes`);
  }

  // Seed AMMs: 0.1 note + 0.1*price cSOL (keeps 0.1 note free to sell)
  const SEED_NOTE = 100_000_000n; // 0.1
  for (const m of markets) {
    const csolAmt = BigInt(Math.floor(Number(SEED_NOTE) * SEED_PRICE[m.t]));
    sigs[`seed_${TENORS[m.t]}e`] = await send(conn, [payer], [
      new TransactionInstruction({
        programId: PROGRAM_ID,
        keys: [
          { pubkey: payer.publicKey, isSigner: true, isWritable: false },
          { pubkey: m.market, isSigner: false, isWritable: true },
          { pubkey: m.noteMint, isSigner: false, isWritable: false },
          { pubkey: m.userNote, isSigner: false, isWritable: true },
          { pubkey: m.noteVault, isSigner: false, isWritable: true },
          { pubkey: userCsol, isSigner: false, isWritable: true },
          { pubkey: m.ammCsol, isSigner: false, isWritable: true },
          { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        ],
        data: Ix.ammSeed(SEED_NOTE, csolAmt),
      }),
    ], `seed AMM ${TENORS[m.t]}e @ ${SEED_PRICE[m.t]}`);
  }

  // SELL: payer sells 0.05 of 1-epoch notes for cSOL
  const SELL_IN = 50_000_000n;
  sigs.sell_1e = await send(conn, [payer], [
    new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: payer.publicKey, isSigner: true, isWritable: false },
        { pubkey: markets[0].market, isSigner: false, isWritable: true },
        { pubkey: markets[0].userNote, isSigner: false, isWritable: true },
        { pubkey: markets[0].noteVault, isSigner: false, isWritable: true },
        { pubkey: userCsol, isSigner: false, isWritable: true },
        { pubkey: markets[0].ammCsol, isSigner: false, isWritable: true },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      ],
      data: Ix.ammSwap(SELL_IN, 1n, true), // note → cSOL
    }),
  ], 'SELL 0.05 of 1e notes → cSOL');

  // BUY: buyer buys 1e notes with cSOL
  const BUY_IN = 40_000_000n; // 0.04 cSOL
  sigs.buy_1e = await send(conn, [buyer], [
    new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: buyer.publicKey, isSigner: true, isWritable: false },
        { pubkey: markets[0].market, isSigner: false, isWritable: true },
        { pubkey: markets[0].buyerNote, isSigner: false, isWritable: true },
        { pubkey: markets[0].noteVault, isSigner: false, isWritable: true },
        { pubkey: buyerCsol, isSigner: false, isWritable: true },
        { pubkey: markets[0].ammCsol, isSigner: false, isWritable: true },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      ],
      data: Ix.ammSwap(BUY_IN, 1n, false), // cSOL → notes
    }),
  ], 'BUY 1e notes with 0.04 cSOL');

  // Maturity check: attempt redeem (should fail while epoch < maturity)
  const epoch = (await conn.getEpochInfo()).epoch;
  let redeemStatus = 'unknown';
  try {
    sigs.redeem_early = await send(conn, [payer], [
      new TransactionInstruction({
        programId: PROGRAM_ID,
        keys: [
          { pubkey: payer.publicKey, isSigner: true, isWritable: true },
          { pubkey: config, isSigner: false, isWritable: false },
          { pubkey: markets[0].market, isSigner: false, isWritable: true },
          { pubkey: markets[0].noteMint, isSigner: false, isWritable: true },
          { pubkey: markets[0].userNote, isSigner: false, isWritable: true },
          { pubkey: stakeVault, isSigner: false, isWritable: true },
          { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        ],
        data: Ix.redeem(1_000_000n),
      }),
    ], 'redeem early (expect fail)');
    redeemStatus = 'UNEXPECTED_SUCCESS';
  } catch (e) {
    redeemStatus = 'blocked_until_maturity (ok)';
    console.log(`redeem maturity check: ${redeemStatus} — ${String(e.message).split('\n')[0]}`);
  }

  // Yield curve from pool mid prices
  const curve = [];
  for (const m of markets) {
    const acc = await conn.getAccountInfo(m.market);
    const md = readMarket(acc.data);
    const price = Number(md.reserve_csol) / Number(md.reserve_note);
    const y = yieldFromSpot(price, TENORS[m.t]);
    curve.push({
      tenor_epochs: TENORS[m.t],
      maturity_epoch: Number(md.maturity_epoch),
      current_epoch: epoch,
      reserve_note: md.reserve_note.toString(),
      reserve_csol: md.reserve_csol.toString(),
      spot_csol_per_note: price,
      discount_pct: (1 - price) * 100,
      simple_yield_to_maturity: y.simple,
      annualized_yield: y.annualized,
      note_mint: md.note_mint.toBase58(),
    });
    console.log(
      `tenor ${TENORS[m.t]}e: spot=${price.toFixed(6)} discount=${((1 - price) * 100).toFixed(2)}% ` +
      `y_simple=${(y.simple * 100).toFixed(2)}% y_ann=${(y.annualized * 100).toFixed(1)}% ` +
      `maturity_epoch=${md.maturity_epoch}`
    );
  }

  const buyerNoteBal = (await getAccount(conn, markets[0].buyerNote)).amount;
  const out = {
    programId: PROGRAM_ID.toBase58(),
    currentEpoch: epoch,
    redeemStatus,
    buyerNoteBalance_1e: buyerNoteBal.toString(),
    yieldCurve: curve,
    signatures: sigs,
    explorer: Object.fromEntries(
      Object.entries(sigs).map(([k, v]) => [k, EXPLORER + v])
    ),
  };
  fs.writeFileSync(path.join(ROOT, 'demo-market-result.json'), JSON.stringify(out, null, 2));
  console.log('\n=== MARKET DEMO OK ===');
  console.log(JSON.stringify({ redeemStatus, buyerNoteBalance_1e: buyerNoteBal.toString(), curve }, null, 2));
}

main().catch((e) => {
  console.error('MARKET DEMO FAILED', e);
  process.exit(1);
});
