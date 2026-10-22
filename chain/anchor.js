// In-memory Anchor runtime for the clawd chain.
// Lamports on these accounts are CLAWD. Instruction and account discriminators
// are the first 8 bytes of sha256("global:<name>") and sha256("account:<Name>").
// A failed instruction, including a failed CPI, restores every account, the
// clock, and the log.
const { PublicKey } = require('@solana/web3.js');
const { sha256 } = require('./codec');

const SYSTEM_PROGRAM_ID = new PublicKey(new Uint8Array(32)).toBase58();
const BPF_LOADER_ID = 'BPFLoaderUpgradeab1e11111111111111111111111';
const ZERO_PUBKEY = SYSTEM_PROGRAM_ID;
const RENT_PER_BYTE = 3480n;
const RENT_BASE = 128n;
const CPI = Symbol('cpi');

function fail(reason) {
  const err = new Error(reason);
  err.reason = reason;
  throw err;
}

function rentExempt(space) {
  return RENT_BASE + RENT_PER_BYTE * BigInt(space);
}

function discriminator(kind, name) {
  return Buffer.from(sha256(Buffer.from(`${kind}:${name}`)).subarray(0, 8));
}

function toSeed(seed) {
  if (typeof seed === 'string') return Buffer.from(seed, 'utf8');
  if (Buffer.isBuffer(seed)) return seed;
  if (seed instanceof Uint8Array) return Buffer.from(seed);
  fail('seeds');
}

function findPda(seeds, programId) {
  const [pk, bump] = PublicKey.findProgramAddressSync(seeds.map(toSeed), new PublicKey(programId));
  return { address: pk.toBase58(), bump };
}

function createProgramAddress(seeds, programId) {
  return PublicKey.createProgramAddressSync(seeds.map(toSeed), new PublicKey(programId)).toBase58();
}

function normalizeAddress(value) {
  if (typeof value === 'string' && value.length > 0) return value;
  if (value && typeof value.toBase58 === 'function') return value.toBase58();
  if (value && typeof value.publicKey === 'string') return value.publicKey;
  if (value && value.publicKey && typeof value.publicKey.toBase58 === 'function') {
    return value.publicKey.toBase58();
  }
  return null;
}

function pubkeyBytes(address) {
  return Buffer.from(new PublicKey(address).toBytes());
}

function asU64(value) {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value);
  if (typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value)) return BigInt(value);
  return null;
}

function encodeField(type, value) {
  if (type === 'u8' || type === 'u16' || type === 'u32') {
    const n = typeof value === 'bigint' ? Number(value) : value;
    const width = type === 'u8' ? 1 : type === 'u16' ? 2 : 4;
    const max = type === 'u8' ? 0xff : type === 'u16' ? 0xffff : 0xffffffff;
    if (!Number.isInteger(n) || n < 0 || n > max) fail('args');
    const buf = Buffer.alloc(width);
    if (type === 'u8') buf.writeUInt8(n);
    else if (type === 'u16') buf.writeUInt16LE(n);
    else buf.writeUInt32LE(n);
    return buf;
  }
  if (type === 'u64') {
    const n = asU64(value);
    if (n == null || n < 0n || n > 0xffffffffffffffffn) fail('args');
    const buf = Buffer.alloc(8);
    buf.writeBigUInt64LE(n);
    return buf;
  }
  if (type === 'bool') return Buffer.from([value ? 1 : 0]);
  if (type === 'pubkey') {
    const address = normalizeAddress(value);
    if (!address) fail('account');
    return pubkeyBytes(address);
  }
  if (type === 'string') {
    if (typeof value !== 'string') fail('args');
    const body = Buffer.from(value, 'utf8');
    const len = Buffer.alloc(4);
    len.writeUInt32LE(body.length);
    return Buffer.concat([len, body]);
  }
  fail('args');
}

function decodeField(type, data, offset) {
  if (offset > data.length) return null;
  if (type === 'u8') {
    if (offset + 1 > data.length) return null;
    return { value: data.readUInt8(offset), offset: offset + 1 };
  }
  if (type === 'u16') {
    if (offset + 2 > data.length) return null;
    return { value: data.readUInt16LE(offset), offset: offset + 2 };
  }
  if (type === 'u32') {
    if (offset + 4 > data.length) return null;
    return { value: data.readUInt32LE(offset), offset: offset + 4 };
  }
  if (type === 'u64') {
    if (offset + 8 > data.length) return null;
    return { value: data.readBigUInt64LE(offset), offset: offset + 8 };
  }
  if (type === 'bool') {
    if (offset + 1 > data.length) return null;
    return { value: data[offset] !== 0, offset: offset + 1 };
  }
  if (type === 'pubkey') {
    if (offset + 32 > data.length) return null;
    return { value: new PublicKey(data.subarray(offset, offset + 32)).toBase58(), offset: offset + 32 };
  }
  if (type === 'string') {
    if (offset + 4 > data.length) return null;
    const len = data.readUInt32LE(offset);
    const start = offset + 4;
    if (start + len > data.length) return null;
    return { value: data.subarray(start, start + len).toString('utf8'), offset: start + len };
  }
  return null;
}

function decodeFields(def, data) {
  let offset = 8;
  const values = {};
  for (const field of def.fields) {
    const decoded = decodeField(field.type, data, offset);
    if (!decoded) return null;
    values[field.name] = decoded.value;
    offset = decoded.offset;
  }
  return values;
}

function encodeAccount(typeName, def, values) {
  const parts = [discriminator('account', typeName)];
  for (const field of def.fields) parts.push(encodeField(field.type, values[field.name]));
  return Buffer.concat(parts);
}

function readAccount(program, typeName, record) {
  const def = program.accounts[typeName];
  if (!def || !record || !record.data || record.data.length < 8) return null;
  const disc = discriminator('account', typeName);
  if (!record.data.subarray(0, 8).equals(disc)) return null;
  return decodeFields(def, record.data);
}

function coerce(type, value) {
  if (type === 'u64') {
    const n = asU64(value);
    if (n == null) fail('args');
    return n;
  }
  if (type === 'u8' || type === 'u16' || type === 'u32') {
    const n = typeof value === 'bigint' ? Number(value) : value;
    if (!Number.isInteger(n) || n < 0) fail('args');
    return n;
  }
  if (type === 'bool') return value === true;
  if (type === 'pubkey') {
    const address = normalizeAddress(value);
    if (!address) fail('account');
    return address;
  }
  if (type === 'string') {
    if (typeof value !== 'string') fail('args');
    return value;
  }
  fail('args');
}

function bindArgs(ix, args) {
  const named = {};
  if (Array.isArray(args)) {
    if (args.length !== ix.args.length) fail('args');
    ix.args.forEach((arg, index) => {
      named[arg.name] = coerce(arg.type, args[index]);
    });
    return named;
  }
  const source = args && typeof args === 'object' ? args : {};
  if (ix.args.length === 0) return named;
  for (const arg of ix.args) {
    if (!Object.prototype.hasOwnProperty.call(source, arg.name)) fail('args');
    named[arg.name] = coerce(arg.type, source[arg.name]);
  }
  return named;
}

function emptyAccount(address, owner, lamports, space, executable) {
  return {
    address,
    owner,
    lamports,
    data: Buffer.alloc(space),
    executable: !!executable,
  };
}

function createChain() {
  const chain = { accounts: new Map(), now: 0n, logs: [] };
  chain.accounts.set(SYSTEM_PROGRAM_ID, emptyAccount(SYSTEM_PROGRAM_ID, BPF_LOADER_ID, 1n, 0, true));
  return chain;
}

function fundChain(chain, address, lamports) {
  const who = normalizeAddress(address);
  const value = asU64(lamports);
  if (!who) return { ok: false, reason: 'account' };
  if (value == null || value <= 0n) return { ok: false, reason: 'amount' };
  let rec = chain.accounts.get(who);
  if (!rec) {
    rec = emptyAccount(who, SYSTEM_PROGRAM_ID, 0n, 0, false);
    chain.accounts.set(who, rec);
  }
  rec.lamports += value;
  return { ok: true, lamports: rec.lamports };
}

function setTime(chain, now) {
  if (typeof now === 'bigint' && now >= 0n) chain.now = now;
  else if (typeof now === 'number' && Number.isSafeInteger(now) && now >= 0) chain.now = BigInt(now);
  else return { ok: false, reason: 'time' };
  return { ok: true, now: chain.now };
}

function snapshotChain(chain) {
  const accounts = new Map();
  for (const [key, rec] of chain.accounts) {
    accounts.set(key, {
      address: rec.address,
      owner: rec.owner,
      lamports: rec.lamports,
      executable: rec.executable,
      data: Buffer.from(rec.data),
    });
  }
  return { accounts, now: chain.now, logs: chain.logs.slice() };
}

function restoreChain(chain, snap) {
  for (const key of [...chain.accounts.keys()]) {
    if (!snap.accounts.has(key)) chain.accounts.delete(key);
  }
  for (const [key, saved] of snap.accounts) {
    const rec = chain.accounts.get(key);
    if (!rec) {
      chain.accounts.set(key, {
        address: saved.address,
        owner: saved.owner,
        lamports: saved.lamports,
        executable: saved.executable,
        data: Buffer.from(saved.data),
      });
    } else {
      rec.owner = saved.owner;
      rec.lamports = saved.lamports;
      rec.executable = saved.executable;
      rec.data = Buffer.from(saved.data);
    }
  }
  chain.now = snap.now;
  chain.logs = snap.logs.slice();
}

function installProgram(chain, program) {
  if (chain.accounts.has(program.id)) return;
  chain.accounts.set(program.id, emptyAccount(program.id, BPF_LOADER_ID, 1n, 0, true));
}

function rawWrapper(chain, address, writable) {
  return {
    key() { return address; },
    get lamports() { return chain.accounts.get(address).lamports; },
    set lamports(value) {
      if (!writable) fail('mut');
      const n = asU64(value);
      if (n == null) fail('amount');
      chain.accounts.get(address).lamports = n;
    },
    get owner() { return chain.accounts.get(address).owner; },
    get executable() { return chain.accounts.get(address).executable; },
  };
}

function zeroValues(def) {
  const values = {};
  for (const field of def.fields) {
    if (field.type === 'u64') values[field.name] = 0n;
    else if (field.type === 'bool') values[field.name] = false;
    else if (field.type === 'string') values[field.name] = '';
    else if (field.type === 'pubkey') values[field.name] = ZERO_PUBKEY;
    else values[field.name] = 0;
  }
  return values;
}

function typedWrapper(chain, address, typeName, def, writable, initial) {
  const values = { ...initial };
  const wrapper = rawWrapper(chain, address, writable);
  for (const field of def.fields) {
    Object.defineProperty(wrapper, field.name, {
      enumerable: true,
      get() { return values[field.name]; },
      set(value) {
        if (!writable) fail('mut');
        values[field.name] = coerce(field.type, value);
      },
    });
  }
  wrapper._values = values;
  wrapper._def = def;
  wrapper._typeName = typeName;
  wrapper._writable = writable;
  return wrapper;
}

function resolveSeed(seed, programId, addresses, wrappers, input) {
  if (typeof seed === 'string' || Buffer.isBuffer(seed) || seed instanceof Uint8Array) return toSeed(seed);
  if (seed && seed.program === true) return pubkeyBytes(programId);
  if (seed && seed.field) {
    const wrapper = wrappers[seed.account];
    if (!wrapper) fail('seeds');
    return encodeField(seed.type, wrapper[seed.field]);
  }
  if (seed && seed.account) {
    const address = addresses[seed.account] || normalizeAddress(input[seed.account]);
    if (!address) fail('seeds');
    return pubkeyBytes(address);
  }
  fail('seeds');
}

function describeSeed(seed) {
  if (typeof seed === 'string') return { kind: 'const', value: seed };
  if (Buffer.isBuffer(seed) || seed instanceof Uint8Array) {
    return { kind: 'const', value: Buffer.from(seed).toString('utf8') };
  }
  if (seed && seed.program === true) return { kind: 'program' };
  if (seed && seed.field) return { kind: 'account', path: `${seed.account}.${seed.field}`, type: seed.type };
  if (seed && seed.account) return { kind: 'account', path: seed.account };
  return { kind: 'const', value: '' };
}

function commitAccounts(chain, wrappers) {
  for (const wrapper of wrappers) {
    if (!wrapper._def || !wrapper._writable) continue;
    const rec = chain.accounts.get(wrapper.key());
    const encoded = encodeAccount(wrapper._typeName, wrapper._def, wrapper._values);
    if (encoded.length > rec.data.length) fail('space');
    rec.data.fill(0);
    encoded.copy(rec.data);
  }
}

function loadInstruction(chain, program, ix, input, userSigners, pdaSigners) {
  const userSet = new Set(userSigners);
  const pdaSet = new Set(pdaSigners);
  const addresses = {};
  const wrappers = {};
  const bumps = {};
  const writable = [];

  for (const meta of ix.accounts) {
    let address = normalizeAddress(input[meta.name]);
    if (meta.seeds) {
      const derived = findPda(meta.seeds.map(seed => resolveSeed(seed, program.id, addresses, wrappers, input)), program.id);
      if (address && address !== derived.address) fail('seeds');
      address = derived.address;
      bumps[meta.name] = derived.bump;
    }
    if (!address) fail('account');
    addresses[meta.name] = address;
    if (meta.address && address !== meta.address) fail('address');

    const canWrite = !!(meta.mut || meta.init || meta.initIfNeeded);
    if (meta.signer && !userSet.has(address) && !pdaSet.has(address)) fail('signer');

    const initSpec = meta.init || meta.initIfNeeded;
    let rec = chain.accounts.get(address);
    let justCreated = false;
    if (meta.init && rec) fail('init');
    if (initSpec && !rec) {
      if (!meta.type || !program.accounts[meta.type]) fail('account');
      const payer = addresses[initSpec.payer] || normalizeAddress(input[initSpec.payer]);
      if (!payer) fail('account');
      if (!userSet.has(payer) && !pdaSet.has(payer)) fail('signer');
      const payerRec = chain.accounts.get(payer);
      if (!payerRec) fail('account');
      if (!Number.isInteger(initSpec.space) || initSpec.space < 8) fail('space');
      const rent = rentExempt(initSpec.space);
      if (payerRec.lamports < rent) fail('rent');
      payerRec.lamports -= rent;
      rec = emptyAccount(address, program.id, rent, initSpec.space, false);
      discriminator('account', meta.type).copy(rec.data, 0);
      chain.accounts.set(address, rec);
      justCreated = true;
    } else if (!rec) {
      // A CLAWD recipient is an untyped system account. Typed accounts and
      // signers stay missing until init or fundChain creates them.
      if (!meta.type && canWrite && !meta.signer) {
        rec = emptyAccount(address, SYSTEM_PROGRAM_ID, 0n, 0, false);
        chain.accounts.set(address, rec);
      } else {
        fail('account');
      }
    }

    if (meta.executable && !rec.executable) fail('executable');
    if (meta.owner) {
      const expected = meta.owner === 'program' ? program.id : (addresses[meta.owner] || normalizeAddress(input[meta.owner]));
      if (!expected || rec.owner !== expected) fail('owner');
    }
    if (meta.type) {
      if (rec.owner !== program.id) fail('owner');
      const disc = discriminator('account', meta.type);
      if (rec.data.length < 8 || !rec.data.subarray(0, 8).equals(disc)) fail('discriminator');
      const def = program.accounts[meta.type];
      const decoded = decodeFields(def, rec.data);
      if (!decoded && !justCreated) fail('account');
      const wrapper = typedWrapper(chain, address, meta.type, def, canWrite, decoded || zeroValues(def));
      wrappers[meta.name] = wrapper;
      if (canWrite) writable.push(wrapper);
    } else {
      wrappers[meta.name] = rawWrapper(chain, address, canWrite);
    }
  }

  return { wrappers, bumps, writable };
}

function run(chain, program, instructionName, input, args, userSigners, pdaSigners) {
  const ix = program.instructionMap[instructionName];
  if (!ix) return { ok: false, reason: 'instruction', logs: [], bumps: {} };
  installProgram(chain, program);
  const snap = snapshotChain(chain);
  const localLogs = [];
  try {
    const bound = bindArgs(ix, args);
    const loaded = loadInstruction(chain, program, ix, input || {}, userSigners, pdaSigners);
    const ctx = {
      accounts: loaded.wrappers,
      bumps: loaded.bumps,
      programId: program.id,
      now: chain.now,
      remainingAccounts: [],
      log(message) {
        const line = String(message);
        localLogs.push(line);
        chain.logs.push(line);
      },
      cpi(target, name, accountMap, cpiArgs, seedSets) {
        const signed = [];
        for (const seeds of seedSets || []) {
          try {
            signed.push(createProgramAddress(seeds, program.id));
          } catch {
            fail('seeds');
          }
        }
        const result = run(chain, target, name, accountMap, cpiArgs, userSigners, signed);
        if (!result.ok) fail(result.reason);
        return result;
      },
    };
    const returned = ix.handler(ctx, bound);
    if (returned && returned.ok === false) fail(returned.reason || 'instruction');
    commitAccounts(chain, loaded.writable);
    return { ok: true, logs: localLogs, bumps: loaded.bumps };
  } catch (err) {
    restoreChain(chain, snap);
    return { ok: false, reason: err && err.reason ? err.reason : 'instruction', logs: localLogs, bumps: {} };
  }
}

function invoke(chain, program, instructionName, accounts, args, signers) {
  const normalized = [];
  for (const signer of signers || []) {
    const address = normalizeAddress(signer);
    if (!address) return { ok: false, reason: 'signer', logs: [], bumps: {} };
    normalized.push(address);
  }
  const input = {};
  for (const [name, value] of Object.entries(accounts || {})) {
    const address = normalizeAddress(value);
    if (!address) return { ok: false, reason: 'account', logs: [], bumps: {} };
    input[name] = address;
  }
  return run(chain, program, instructionName, input, args, normalized, []);
}

function defineProgram({ id, name, accounts, instructions }) {
  let programId;
  try {
    programId = new PublicKey(id).toBase58();
  } catch {
    throw new Error('program id');
  }
  const accountDefs = accounts || {};
  const list = instructions || [];
  const instructionMap = Object.create(null);
  for (const ix of list) {
    instructionMap[ix.name] = {
      name: ix.name,
      args: ix.args || [],
      accounts: ix.accounts || [],
      handler: ix.handler,
    };
  }
  return { id: programId, name, accounts: accountDefs, instructions: list, instructionMap };
}

function idlOf(program) {
  return {
    address: program.id,
    name: program.name,
    instructions: program.instructions.map(ix => ({
      name: ix.name,
      discriminator: [...discriminator('global', ix.name)],
      accounts: (ix.accounts || []).map(meta => {
        const account = {
          name: meta.name,
          signer: !!meta.signer,
          writable: !!(meta.mut || meta.init || meta.initIfNeeded),
        };
        if (meta.seeds) account.pda = { seeds: meta.seeds.map(describeSeed) };
        if (meta.address) account.address = meta.address;
        return account;
      }),
      args: (ix.args || []).map(arg => ({ name: arg.name, type: arg.type })),
    })),
    accounts: Object.entries(program.accounts).map(([accountName, def]) => ({
      name: accountName,
      discriminator: [...discriminator('account', accountName)],
      type: { kind: 'struct', fields: def.fields.map(field => ({ name: field.name, type: field.type })) },
    })),
  };
}

function camel(name) {
  return name.slice(0, 1).toLowerCase() + name.slice(1);
}

function createClient(chain, program) {
  const methods = {};
  for (const ix of program.instructions) {
    methods[ix.name] = (...args) => {
      const builder = {
        _accounts: {},
        _signers: [],
        accounts(map) {
          this._accounts = map || {};
          return this;
        },
        signers(list) {
          this._signers = list || [];
          return this;
        },
        rpc() {
          return invoke(chain, program, ix.name, this._accounts, args, this._signers);
        },
      };
      return builder;
    };
  }
  const account = {};
  for (const accountName of Object.keys(program.accounts)) {
    const api = {
      fetch(address) {
        const rec = chain.accounts.get(normalizeAddress(address));
        return readAccount(program, accountName, rec);
      },
      all() {
        const found = [];
        for (const rec of chain.accounts.values()) {
          const decoded = readAccount(program, accountName, rec);
          if (decoded) found.push({ publicKey: rec.address, account: decoded });
        }
        return found;
      },
    };
    account[accountName] = api;
    account[camel(accountName)] = api;
  }
  return { methods, account, programId: program.id, idl: idlOf(program) };
}

const systemProgram = defineProgram({
  id: SYSTEM_PROGRAM_ID,
  name: 'system',
  accounts: {},
  instructions: [
    {
      name: 'transfer',
      args: [{ name: 'amount', type: 'u64' }],
      accounts: [
        { name: 'from', signer: true, mut: true },
        { name: 'to', mut: true },
      ],
      handler(ctx, { amount }) {
        if (amount <= 0n) fail('amount');
        if (ctx.accounts.from.lamports < amount) fail('balance');
        ctx.accounts.from.lamports -= amount;
        ctx.accounts.to.lamports += amount;
      },
    },
  ],
});

module.exports = {
  SYSTEM_PROGRAM_ID,
  BPF_LOADER_ID,
  ZERO_PUBKEY,
  RENT_PER_BYTE,
  RENT_BASE,
  rentExempt,
  discriminator,
  findPda,
  createChain,
  fundChain,
  credit: fundChain,
  setTime,
  defineProgram,
  invoke,
  idlOf,
  extractIdl: idlOf,
  createClient,
  readAccount,
  systemProgram,
  fail,
  pubkeyBytes,
};
