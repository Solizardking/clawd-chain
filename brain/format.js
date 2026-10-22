// Turn a confirmed clawd block entry into a Supermemory document.
// Amounts stay exact: 1 CLAWD = 1_000_000_000 lamports.

const CONTEXT = 'This is one confirmed transaction or a chain snapshot from clawd, a public Solana-compatible chain. The native token is CLAWD. 1 CLAWD = 1000000000 lamports. Keep signatures, account addresses, mint addresses, owners, slot numbers, and raw amounts exactly as written. A leading + or - on an amount is the change, not part of the address.';

const NAMES = {
  '11111111111111111111111111111111': 'System',
  TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA: 'Token',
  TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb: 'Token-2022',
  metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s: 'Token Metadata',
  CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d: 'Metaplex Core',
  CMACYFENjoBMHzapRXyo1JZkVS6EtaDDzkjMrmQLvr4J: 'Candy Machine',
  CMAGAKJ67e9hRZgfC5SFTbZH8MgEmtqazKXjmkaJjWTJ: 'Candy Guard',
  '1DREGFgysWYxLnRnKQnwrxnJQeSMk2HmGaC6whw2B2p': 'Agent Identity',
  TLREGni9ZEyGC3vnPZtqUh95xQ8oPqJSvNjvB7FGK8S: 'Agent Tools',
  GNS1S5J5AspKXgpjz6SvKL66kPaKWAhaGRhCqPRxii2B: 'Genesis',
  '2AMyS5oLqvh2j4We5EUe9cHryd2vrCuVSdZtsZrP2PVH': 'Clawd Shield',
  ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL: 'Associated Token',
  ComputeBudget111111111111111111111111111111: 'Compute Budget',
};

function label(id) {
  if (!id) return '';
  return NAMES[id] ? `${NAMES[id]} (${id})` : id;
}

function clawd(lamports) {
  const n = BigInt(lamports);
  const neg = n < 0n;
  const v = neg ? -n : n;
  const whole = v / 1_000_000_000n;
  let frac = (v % 1_000_000_000n).toString().padStart(9, '0').replace(/0+$/, '');
  const s = frac ? `${whole}.${frac}` : `${whole}`;
  return neg ? `-${s}` : s;
}

function signedClawd(lamports) {
  const n = BigInt(lamports);
  const body = clawd(n < 0n ? -n : n);
  if (n > 0n) return `+${body}`;
  if (n < 0n) return `-${body}`;
  return body;
}

function accountKeys(entry) {
  const keys = entry?.transaction?.message?.accountKeys || [];
  return keys.map(k => (typeof k === 'string' ? k : k.pubkey)).filter(Boolean);
}

function signersOf(entry) {
  const keys = entry?.transaction?.message?.accountKeys || [];
  if (keys.some(k => k && typeof k === 'object' && 'signer' in k)) return keys.filter(k => k.signer).map(k => k.pubkey);
  const n = entry?.transaction?.message?.header?.numRequiredSignatures || 0;
  return accountKeys(entry).slice(0, n);
}

function programIds(entry) {
  const keys = accountKeys(entry);
  const inner = (entry?.meta?.innerInstructions || []).flatMap(g => g.instructions || []);
  const ixs = [...(entry?.transaction?.message?.instructions || []), ...inner];
  const ids = [];
  for (const ix of ixs) {
    const id = ix.programId || (ix.programIdIndex != null ? keys[ix.programIdIndex] : '');
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

function instructionLines(entry) {
  const keys = accountKeys(entry);
  const inner = (entry?.meta?.innerInstructions || []).flatMap(g => g.instructions || []);
  const ixs = [...(entry?.transaction?.message?.instructions || []), ...inner].slice(0, 16);
  return ixs.map(ix => {
    const program = ix.programId || (ix.programIdIndex != null ? keys[ix.programIdIndex] : '') || ix.program || 'program';
    if (ix.parsed && typeof ix.parsed === 'object') {
      const info = ix.parsed.info || {};
      const bits = Object.entries(info).slice(0, 8).map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`);
      return `${label(program)} ${ix.parsed.type || ''} ${bits.join(' ')}`.trim();
    }
    return label(program);
  });
}

function nativeMoves(entry) {
  const keys = accountKeys(entry);
  const pre = entry?.meta?.preBalances || [];
  const post = entry?.meta?.postBalances || [];
  const out = [];
  for (let i = 0; i < Math.max(pre.length, post.length); i++) {
    const delta = BigInt(post[i] || 0) - BigInt(pre[i] || 0);
    if (delta === 0n) continue;
    out.push({ address: keys[i] || String(i), delta });
  }
  return out;
}

function tokenMoves(entry) {
  const key = b => `${b.accountIndex}:${b.mint}:${b.owner || ''}`;
  const pre = new Map((entry?.meta?.preTokenBalances || []).map(b => [key(b), b]));
  const post = new Map((entry?.meta?.postTokenBalances || []).map(b => [key(b), b]));
  const out = [];
  for (const k of new Set([...pre.keys(), ...post.keys()])) {
    const before = pre.get(k);
    const after = post.get(k);
    const row = after || before;
    const from = BigInt(before?.uiTokenAmount?.amount || '0');
    const to = BigInt(after?.uiTokenAmount?.amount || '0');
    if (from === to) continue;
    const decimals = Number(row.uiTokenAmount?.decimals ?? 0);
    out.push({
      mint: row.mint,
      owner: row.owner || '',
      programId: row.programId || '',
      decimals,
      delta: to - from,
    });
  }
  return out;
}

function formatRaw(amount, decimals) {
  const n = BigInt(amount);
  const neg = n < 0n;
  const v = (neg ? -n : n).toString().padStart(decimals + 1, '0');
  const whole = decimals ? v.slice(0, -decimals) : v;
  const frac = decimals ? v.slice(-decimals).replace(/0+$/, '') : '';
  const body = frac ? `${whole}.${frac}` : whole;
  if (n > 0n) return `+${body}`;
  if (n < 0n) return `-${body}`;
  return body;
}

function statusOf(meta) {
  if (!meta || meta.err == null) return 'ok';
  return typeof meta.err === 'string' ? meta.err : JSON.stringify(meta.err);
}

function txDocument({ slot, blockTime, entry }) {
  const signature = entry?.transaction?.signatures?.[0];
  if (!signature) return null;
  const status = statusOf(entry.meta);
  const fee = entry?.meta?.fee || 0;
  const signers = signersOf(entry);
  const programs = programIds(entry);
  const native = nativeMoves(entry);
  const tokens = tokenMoves(entry);
  const logs = (entry?.meta?.logMessages || []).slice(0, 25).join('\n').slice(0, 2000);
  const lines = [
    'clawd chain transaction',
    `signature: ${signature}`,
    `slot: ${slot}`,
    blockTime ? `time: ${new Date(blockTime * 1000).toISOString()}` : '',
    `status: ${status}`,
    `fee: ${fee} lamports (${clawd(fee)} CLAWD)`,
    signers.length ? `signers: ${signers.join(', ')}` : '',
    programs.length ? `programs: ${programs.map(label).join(', ')}` : '',
    native.length ? 'native CLAWD:' : '',
    ...native.map(m => `  ${m.address} ${signedClawd(m.delta)} CLAWD (${m.delta > 0n ? '+' : ''}${m.delta} lamports)`),
    tokens.length ? 'tokens:' : '',
    ...tokens.map(m => `  mint ${m.mint} owner ${m.owner || 'unknown'} ${formatRaw(m.delta, m.decimals)} (raw ${m.delta > 0n ? '+' : ''}${m.delta}, decimals ${m.decimals}) via ${label(m.programId)}`),
    instructionLines(entry).length ? 'instructions:' : '',
    ...instructionLines(entry).map(l => `  ${l}`),
    logs ? `logs:\n${logs}` : '',
  ].filter(Boolean);
  const metadata = {
    kind: 'tx',
    signature,
    slot: Number(slot),
    status: status === 'ok' ? 'ok' : 'err',
    fee: Number(fee),
  };
  if (signers[0]) metadata.signer = signers[0];
  const mints = [...new Set(tokens.map(t => t.mint).filter(Boolean))].slice(0, 20);
  if (mints.length) metadata.mints = mints;
  const doc = {
    id: `tx-${signature}`.slice(0, 255),
    content: lines.join('\n').slice(0, 12000),
    supportingContext: CONTEXT,
    metadata,
    group: 'tx',
  };
  if (blockTime) doc.date = new Date(blockTime * 1000).toISOString();
  return doc;
}

function snapshotDocument(info) {
  const slot = Number(info.slot);
  const total = info.total == null ? null : BigInt(info.total);
  const circulating = info.circulating == null ? null : BigInt(info.circulating);
  const lines = [
    'clawd chain snapshot',
    `slot: ${slot}`,
    info.epoch == null ? '' : `epoch: ${info.epoch}`,
    info.blockHeight == null ? '' : `block height: ${info.blockHeight}`,
    info.transactionCount == null ? '' : `transaction count: ${info.transactionCount}`,
    total == null ? '' : `supply: ${total} lamports (${clawd(total)} CLAWD)`,
    circulating == null ? '' : `circulating: ${circulating} lamports (${clawd(circulating)} CLAWD)`,
  ].filter(Boolean);
  return {
    id: `snapshot-${slot}`,
    content: lines.join('\n'),
    supportingContext: CONTEXT,
    metadata: { kind: 'snapshot', slot },
    group: 'snapshot',
    date: new Date().toISOString(),
  };
}

module.exports = { txDocument, snapshotDocument, clawd, CONTEXT, label };
