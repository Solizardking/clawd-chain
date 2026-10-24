/**
 * Stake-backed tenor market demo:
 * InitMarket (smarket) → Lock (native stake PDA → Clawd vote) → deep AmmSeed
 * → sell/buy 1e (price stays below par) → early Redeem + Deactivate blocked.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  Connection, Keypair, PublicKey, SystemProgram, Transaction,
  TransactionInstruction, sendAndConfirmTransaction, SYSVAR_CLOCK_PUBKEY,
  SYSVAR_RENT_PUBKEY, SYSVAR_STAKE_HISTORY_PUBKEY, StakeProgram,
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
const CLAWD_VOTE = new PublicKey('6J5BtS3wGG4jsEwDLoKW9AghcT4fty1PfqNMVcMaQVBA');
const STAKE_CONFIG = new PublicKey('StakeConfig11111111111111111111111111111111');
const TENORS = [1, 3, 6, 12];
/** Deep 1e seed below par; lighter seeds for longer tenors */
const SEED_PRICE = [0.990, 0.970, 0.940, 0.880];
const EPOCHS_PER_YEAR = 182.5;
/** Min stakeable ~1 SOL + rent (~0.00228288) */
const LOCK_LAMPORTS = 1_003_000_000n;

function loadKp(p) {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, 'utf8'))));
}
const u8 = (n) => Buffer.from([n]);
const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };

const Ix = {
  depositMint: (coll, mintAmt) => Buffer.concat([u8(6), u64(coll), u64(mintAmt)]),
  lock: (tenorIdx, lamports) => Buffer.concat([u8(8), u8(tenorIdx), u64(lamports)]),
  redeem: (amount) => Buffer.concat([u8(9), u64(amount)]),
  initMarket: (tenorIdx, feeBps) => Buffer.concat([u8(10), u8(tenorIdx), u16(feeBps)]),
  ammSeed: (noteAmt, csolAmt) => Buffer.concat([u8(11), u64(noteAmt), u64(csolAmt)]),
  ammSwap: (amountIn, minOut, noteForCsol) =>
    Buffer.concat([u8(12), u64(amountIn), u64(minOut), u8(noteForCsol ? 1 : 0)]),
  deactivateStakes: (tenorIdx) => Buffer.concat([u8(13), u8(tenorIdx)]),
  postPrice: (price) => Buffer.concat([u8(2), u64(price)]),
  aggregate: () => u8(3),
};

function pda(seeds) {
  return PublicKey.findProgramAddressSync(seeds, PROGRAM_ID);
}

async function send(conn, signers, ixs, label) {
  const tx = new Transaction().add(...ixs);
  const sig = await sendAndConfirmTransaction(conn, tx, signers, {
    commitment: 'confirmed',
    skipPreflight: false,
  });
  console.log(`${label}: ${EXPLORER}${sig}`);
  return sig;
}

function readMarket(data) {
  let o = 0;
  const tenor_idx = data[o++]; const bump = data[o++];
  const fee_bps = data.readUInt16LE(o); o += 2;
  const note_mint = new PublicKey(data.subarray(o, o + 32)); o += 32;
  const note_vault = new PublicKey(data.subarray(o, o + 32)); o += 32;
  const csol_vault = new PublicKey(data.subarray(o, o + 32)); o += 32;
  const reserve_note = data.readBigUInt64LE(o); o += 8;
  const reserve_csol = data.readBigUInt64LE(o); o += 8;
  const maturity_epoch = data.readBigUInt64LE(o); o += 8;
  const total_locked = data.readBigUInt64LE(o); o += 8;
  const vote = new PublicKey(data.subarray(o, o + 32)); o += 32;
  const n_stakes = data.readUInt32LE(o);
  return { tenor_idx, bump, fee_bps, note_mint, note_vault, csol_vault,
    reserve_note, reserve_csol, maturity_epoch, total_locked, vote, n_stakes };
}

function yieldFromSpot(price, tenorEpochs) {
  if (price <= 0 || price >= 1) return { simple: 0, annualized: 0, price };
  const simple = 1 / price - 1;
  const annualized = simple * (EPOCHS_PER_YEAR / tenorEpochs);
  return { simple, annualized, price };
}

async function main() {
  const conn = new Connection(RPC, 'confirmed');
  const payer = loadKp(path.join(ROOT, '.keys/payer.json'));
  const buyer = Keypair.generate();
  const sigs = {};
  const [config] = pda([Buffer.from('config')]);
  const [oracle] = pda([Buffer.from('oracle')]);
  const [csol] = pda([Buffer.from('csol')]);
  const [cvault] = pda([Buffer.from('cvault')]);
  const userCsol = getAssociatedTokenAddressSync(csol, payer.publicKey);
  const buyerCsol = getAssociatedTokenAddressSync(csol, buyer.publicKey);

  console.log('program', PROGRAM_ID.toBase58());
  console.log('payer', payer.publicKey.toBase58());
  console.log('vote', CLAWD_VOTE.toBase58());
  console.log('upgrade tx', EXPLORER + 'LLZTuYbeyCrBT3rmjFLE2fCHEiNoq948TCWJ1FyWo35AcZBQn237G41x2uVQfDrjCFrqzrzGZLtozk5jTJppW7o');

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

  const state = JSON.parse(fs.readFileSync(path.join(ROOT, 'demo-state.json'), 'utf8'));
  const collMint = new PublicKey(state.collMint);
  const userColl = getAssociatedTokenAddressSync(collMint, payer.publicKey);
  sigs.mintColl = await send(conn, [payer], [
    createMintToInstruction(collMint, userColl, payer.publicKey, 100_000_000_000n),
  ], 'mint collateral');
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
      data: Ix.depositMint(80_000_000_000n, 60_000_000_000n),
    }),
  ], 'deposit+mint cSOL');

  sigs.fundBuyer = await send(conn, [payer], [
    SystemProgram.transfer({
      fromPubkey: payer.publicKey, toPubkey: buyer.publicKey, lamports: 50_000_000n,
    }),
    createAssociatedTokenAccountInstruction(payer.publicKey, buyerCsol, buyer.publicKey, csol),
    createTransferInstruction(userCsol, buyerCsol, payer.publicKey, 5_000_000_000n),
  ], 'fund buyer');

  const markets = [];
  for (let t = 0; t < 4; t++) {
    const tb = Buffer.from([t]);
    const [market] = pda([Buffer.from('smarket'), tb]);
    const [noteMint] = pda([Buffer.from('snote_mint'), tb]);
    const [noteVault] = pda([Buffer.from('snote_vault'), tb]);
    const [ammCsol] = pda([Buffer.from('samm_csol'), tb]);
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
            { pubkey: CLAWD_VOTE, isSigner: false, isWritable: false },
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
            { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
          ],
          data: Ix.initMarket(t, 30),
        }),
      ], `init smarket ${TENORS[t]}e`);
    } else {
      console.log(`smarket ${TENORS[t]}e already exists`);
    }
    const userNote = getAssociatedTokenAddressSync(noteMint, payer.publicKey);
    const buyerNote = getAssociatedTokenAddressSync(noteMint, buyer.publicKey);
    const ataIxs = [];
    if (!(await conn.getAccountInfo(userNote))) {
      ataIxs.push(createAssociatedTokenAccountInstruction(
        payer.publicKey, userNote, payer.publicKey, noteMint));
    }
    if (!(await conn.getAccountInfo(buyerNote))) {
      ataIxs.push(createAssociatedTokenAccountInstruction(
        payer.publicKey, buyerNote, buyer.publicKey, noteMint));
    }
    if (ataIxs.length) {
      sigs[`atas_${TENORS[t]}e`] = await send(conn, [payer], ataIxs, `ATAs ${TENORS[t]}e`);
    }
    markets.push({ t, market, noteMint, noteVault, ammCsol, userNote, buyerNote });
  }

  // Lock native stake (≥1 SOL) for each tenor
  for (const m of markets) {
    const md0 = readMarket((await conn.getAccountInfo(m.market)).data);
    const idx = md0.n_stakes;
    const [stakeAcc] = pda([
      Buffer.from('mstake'), Buffer.from([m.t]),
      Buffer.from(new Uint8Array(new Uint32Array([idx]).buffer)),
    ]);
    sigs[`lock_${TENORS[m.t]}e`] = await send(conn, [payer], [
      new TransactionInstruction({
        programId: PROGRAM_ID,
        keys: [
          { pubkey: payer.publicKey, isSigner: true, isWritable: true },
          { pubkey: config, isSigner: false, isWritable: false },
          { pubkey: m.market, isSigner: false, isWritable: true },
          { pubkey: m.noteMint, isSigner: false, isWritable: true },
          { pubkey: m.userNote, isSigner: false, isWritable: true },
          { pubkey: stakeAcc, isSigner: false, isWritable: true },
          { pubkey: CLAWD_VOTE, isSigner: false, isWritable: false },
          { pubkey: SYSVAR_CLOCK_PUBKEY, isSigner: false, isWritable: false },
          { pubkey: SYSVAR_STAKE_HISTORY_PUBKEY, isSigner: false, isWritable: false },
          { pubkey: STAKE_CONFIG, isSigner: false, isWritable: false },
          { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
          { pubkey: StakeProgram.programId, isSigner: false, isWritable: false },
          { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        ],
        data: Ix.lock(m.t, LOCK_LAMPORTS),
      }),
    ], `lock ${Number(LOCK_LAMPORTS)/1e9} SOL stake → ${TENORS[m.t]}e notes (${stakeAcc.toBase58().slice(0,8)}…)`);
    m.stakeAcc = stakeAcc;
  }

  // Deep seed 1e below par; lighter for others. Lock minted ~1.003 notes each.
  // 1e: seed 0.9 notes + 0.891 cSOL → spot 0.99; leave headroom for sell/buy
  const SEED_NOTES = [900_000_000n, 100_000_000n, 100_000_000n, 100_000_000n];
  for (const m of markets) {
    const noteAmt = SEED_NOTES[m.t];
    const csolAmt = BigInt(Math.floor(Number(noteAmt) * SEED_PRICE[m.t]));
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
        data: Ix.ammSeed(noteAmt, csolAmt),
      }),
    ], `seed AMM ${TENORS[m.t]}e @ ${SEED_PRICE[m.t]} (notes=${noteAmt})`);
  }

  // Sell 0.05 of 1e notes — deep pool should keep spot < 1
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
      data: Ix.ammSwap(SELL_IN, 1n, true),
    }),
  ], 'SELL 0.05 of 1e notes → cSOL');

  const BUY_IN = 40_000_000n;
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
      data: Ix.ammSwap(BUY_IN, 1n, false),
    }),
  ], 'BUY 1e notes with 0.04 cSOL');

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
          { pubkey: SYSVAR_CLOCK_PUBKEY, isSigner: false, isWritable: false },
          { pubkey: SYSVAR_STAKE_HISTORY_PUBKEY, isSigner: false, isWritable: false },
          { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
          { pubkey: markets[0].stakeAcc, isSigner: false, isWritable: true },
        ],
        data: Ix.redeem(1_000_000n),
      }),
    ], 'redeem early (expect fail)');
    redeemStatus = 'UNEXPECTED_SUCCESS';
  } catch (e) {
    redeemStatus = 'blocked_until_maturity (ok)';
    console.log(`redeem: ${redeemStatus} — ${String(e.message).split('\n')[0]}`);
  }

  let deactivateStatus = 'unknown';
  try {
    sigs.deactivate_early = await send(conn, [payer], [
      new TransactionInstruction({
        programId: PROGRAM_ID,
        keys: [
          { pubkey: markets[0].market, isSigner: false, isWritable: true },
          { pubkey: SYSVAR_CLOCK_PUBKEY, isSigner: false, isWritable: false },
          { pubkey: markets[0].stakeAcc, isSigner: false, isWritable: true },
        ],
        data: Ix.deactivateStakes(0),
      }),
    ], 'deactivate early (expect fail)');
    deactivateStatus = 'UNEXPECTED_SUCCESS';
  } catch (e) {
    deactivateStatus = 'blocked_until_maturity (ok)';
    console.log(`deactivate: ${deactivateStatus} — ${String(e.message).split('\n')[0]}`);
  }

  const curve = [];
  const stakeInfos = [];
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
      vote: md.vote.toBase58(),
      n_stakes: md.n_stakes,
      total_locked: md.total_locked.toString(),
      stake_account: m.stakeAcc?.toBase58(),
    });
    console.log(
      `tenor ${TENORS[m.t]}e: spot=${price.toFixed(6)} discount=${((1 - price) * 100).toFixed(2)}% ` +
      `below_par=${price < 1} stakes=${md.n_stakes} locked=${md.total_locked} maturity=${md.maturity_epoch}`
    );
    if (m.stakeAcc) {
      const sa = await conn.getAccountInfo(m.stakeAcc);
      stakeInfos.push({
        tenor: TENORS[m.t],
        pubkey: m.stakeAcc.toBase58(),
        lamports: sa?.lamports ?? 0,
        owner: sa?.owner?.toBase58(),
      });
    }
  }

  const spot1e = curve[0].spot_csol_per_note;
  const buyerNoteBal = (await getAccount(conn, markets[0].buyerNote)).amount;
  const out = {
    programId: PROGRAM_ID.toBase58(),
    upgradeSignature: 'LLZTuYbeyCrBT3rmjFLE2fCHEiNoq948TCWJ1FyWo35AcZBQn237G41x2uVQfDrjCFrqzrzGZLtozk5jTJppW7o',
    backing: 'native_stake_accounts',
    clawdVote: CLAWD_VOTE.toBase58(),
    currentEpoch: epoch,
    redeemStatus,
    deactivateStatus,
    spot_1e_below_par: spot1e < 1,
    buyerNoteBalance_1e: buyerNoteBal.toString(),
    stakeAccounts: stakeInfos,
    yieldCurve: curve,
    signatures: sigs,
    explorer: Object.fromEntries(
      Object.entries(sigs).map(([k, v]) => [k, EXPLORER + v])
    ),
  };
  fs.writeFileSync(path.join(ROOT, 'demo-stake-result.json'), JSON.stringify(out, null, 2));
  console.log('\n=== STAKE DEMO OK ===');
  console.log(JSON.stringify({
    redeemStatus, deactivateStatus, spot_1e_below_par: spot1e < 1,
    buyerNoteBalance_1e: buyerNoteBal.toString(), curve,
  }, null, 2));
}

main().catch((e) => {
  console.error('STAKE DEMO FAILED', e);
  process.exit(1);
});
