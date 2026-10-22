// e2e + negative tests for clawd_shield. RPC=<url> node scripts/e2e.js
const anchor=require('@coral-xyz/anchor');const {Connection,Keypair:SK,PublicKey,ComputeBudgetProgram,SystemProgram,LAMPORTS_PER_SOL:L}=require('@solana/web3.js');
const fs=require('fs');const S=require('../sdk/shield');
const RPC=process.env.RPC||'http://127.0.0.1:8999';const conn=new Connection(RPC,'confirmed');
const kp=f=>SK.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(f))));
const idl=JSON.parse(fs.readFileSync('target/idl/clawd_shield.json'));
const deployer=kp('.keys/deployer.json'),relayer=kp('.keys/relayer.json'),user1=kp('.keys/user1.json'),user2=kp('.keys/user2.json');
const prog=new anchor.Program(idl,new anchor.AnchorProvider(conn,new anchor.Wallet(deployer),{commitment:'confirmed'}));
const PID=prog.programId;const pda=(...s)=>PublicKey.findProgramAddressSync(s,PID)[0];
const pool=pda(Buffer.from('pool')),vault=pda(Buffer.from('vault'));
const W='build/transact_js/transact.wasm',Z='build/transact_final.zkey';
const results=[];const log=(k,v)=>{console.log(k,v);results.push([k,v])};
const arr=x=>[...S.be32(x)];
async function send(p,{signer,recipient,relayerPk,override={}}){
  const extAmount=override.extAmount??p.ext.extAmount, fee=p.ext.fee;
  const nf=p.input.inputNullifier, cm=p.input.outputCommitment;
  const root=override.root??arr(p.input.root);
  const proof=override.proof??p.proofBytes;
  const ix=await prog.methods.transact(proof,root,arr(nf[0]),arr(nf[1]),arr(cm[0]),arr(cm[1]),new anchor.BN(extAmount.toString()),new anchor.BN(fee.toString()),p.ext.enc1,p.ext.enc2)
    .accountsPartial({pool,vault,nullifier0:pda(Buffer.from('nf'),S.be32(nf[0])),nullifier1:pda(Buffer.from('nf'),S.be32(nf[1])),
      recipient:new PublicKey(recipient),relayer:new PublicKey(relayerPk),signer:signer.publicKey,systemProgram:SystemProgram.programId}).instruction();
  const tx=new anchor.web3.Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({units:1_400_000}),ix);
  tx.feePayer=signer.publicKey;tx.recentBlockhash=(await conn.getLatestBlockhash()).blockhash;tx.sign(signer);
  const raw=tx.serialize();
  const sig=await conn.sendRawTransaction(raw,{skipPreflight:true});
  try{await conn.confirmTransaction(sig,'confirmed');}catch(e){}
  let t;for(let i=0;i<20&&!t;i++){t=await conn.getTransaction(sig,{commitment:'confirmed',maxSupportedTransactionVersion:0});if(!t)await new Promise(r=>setTimeout(r,500));}
  return {sig,size:raw.length,cu:t.meta.computeUnitsConsumed,err:t.meta.err,logs:t.meta.logMessages};
}
async function expectFail(name,fn,want){const r=await fn();const ok=!!r.err&&(!want||r.logs.join('\n').includes(want));
  log(`NEG ${name}`,{rejected:ok,sig:r.sig,err:JSON.stringify(r.err),reason:(r.logs.find(l=>/Error Message|already in use/.test(l))||'').slice(0,140)});if(!ok)process.exitCode=1;}
(async()=>{await S.init();
  if(!(await conn.getAccountInfo(pool))){const s=await prog.methods.initialize().accountsPartial({pool,vault,authority:deployer.publicKey}).rpc();log('initialize',s);}
  // rebuild tree from chain events (indexer path)
  const tree=new S.MerkleTree();const coder=new anchor.BorshEventCoder(idl);
  const sigs=(await conn.getSignaturesForAddress(PID,{limit:1000})).reverse();const leaves=[];
  for(const s of sigs){if(s.err)continue;const t=await conn.getTransaction(s.signature,{commitment:'confirmed',maxSupportedTransactionVersion:0});
    for(const l of t?.meta?.logMessages||[])if(l.startsWith('Program data: ')){const e=coder.decode(l.slice(14));if(e?.name.toLowerCase()==='newcommitment')leaves.push([e.data.index,S.fromBe(e.data.commitment)]);}}
  leaves.sort((a,b)=>a[0]-b[0]).forEach(([,c])=>tree.insert(c));
  const st=await prog.account.pool.fetch(pool);if(st.nextIndex!==tree.layers[0].length)throw new Error('tree mismatch '+st.nextIndex);
  log('tree rebuilt from events, leaves',tree.layers[0].length);
  const alice=new S.Keypair(),bob=new S.Keypair();
  // 1) deposit 10 CLAWD from user1
  const d1=new S.Note({amount:10n*BigInt(L),keypair:alice}),z=new S.Note({amount:0n,keypair:alice});
  let p=await S.prove({tree,inputs:[],outputs:[d1,z],extAmount:10n*BigInt(L),fee:0n,recipient:user1.publicKey,relayer:user1.publicKey,encPubs:[alice.enc.publicKey,alice.enc.publicKey],wasm:W,zkey:Z});
  let r=await send(p,{signer:user1,recipient:user1.publicKey,relayerPk:user1.publicKey});
  log('deposit 10 CLAWD',{sig:r.sig,cu:r.cu,size:r.size,err:r.err});if(r.err){console.log(r.logs.join('\n'));process.exit(1);}
  tree.insert(p.input.outputCommitment[0]);tree.insert(p.input.outputCommitment[1]);
  // 2) private transfer: alice -> bob 4, change 6 to alice; relayed (fee 0.01) by relayer
  const fee=10_000_000n;const b4=new S.Note({amount:4n*BigInt(L),pub:bob.pub}),c6=new S.Note({amount:6n*BigInt(L)-fee,keypair:alice});
  p=await S.prove({tree,inputs:[d1],outputs:[b4,c6],extAmount:0n,fee,recipient:relayer.publicKey,relayer:relayer.publicKey,encPubs:[bob.enc.publicKey,alice.enc.publicKey],wasm:W,zkey:Z});
  r=await send(p,{signer:relayer,recipient:relayer.publicKey,relayerPk:relayer.publicKey});
  log('shielded transfer 4 CLAWD (relayed)',{sig:r.sig,cu:r.cu,size:r.size,err:r.err});if(r.err){console.log(r.logs.join('\n'));process.exit(1);}
  const transferProof=p;const startIdx=tree.layers[0].length;tree.insert(p.input.outputCommitment[0]);tree.insert(p.input.outputCommitment[1]);
  // bob scans: decrypt his note from the event
  const ev=r.logs.filter(l=>l.startsWith('Program data: ')).map(l=>coder.decode(l.slice(14))).filter(e=>e?.name.toLowerCase()==='newcommitment');
  const found=ev.map(e=>S.Note.decrypt(bob,(e.data.encrypted_output??e.data.encryptedOutput),e.data.index)).find(Boolean);
  log('bob decrypted note from chain event',{amount:found&&found.amount.toString(),index:found&&found.index});
  // 3) bob withdraws 3.9 to fresh address via relayer, fee 0.1
  const dest=SK.generate().publicKey;const wfee=100_000_000n;
  const out=[new S.Note({amount:0n,keypair:bob}),new S.Note({amount:0n,keypair:bob})];
  p=await S.prove({tree,inputs:[found],outputs:out,extAmount:-(4n*BigInt(L)-wfee),fee:wfee,recipient:dest,relayer:relayer.publicKey,encPubs:[bob.enc.publicKey,bob.enc.publicKey],wasm:W,zkey:Z});
  // NEG: unbound recipient (proof bound to dest, submit to attacker)
  const attacker=SK.generate().publicKey;
  await expectFail('unbound recipient',()=>send(p,{signer:relayer,recipient:attacker,relayerPk:relayer.publicKey}),'invalid proof');
  // NEG: value inflation (ask for more than proved)
  await expectFail('value inflation',()=>send(p,{signer:relayer,recipient:dest,relayerPk:relayer.publicKey,override:{extAmount:-(10n*BigInt(L))}}),'invalid proof');
  // NEG: bad proof (flip a byte of C)
  const bad={...p.proofBytes,c:[...p.proofBytes.c]};bad.c[40]^=1;
  await expectFail('bad proof',()=>send(p,{signer:relayer,recipient:dest,relayerPk:relayer.publicKey,override:{proof:bad}}));
  // NEG: wrong root
  await expectFail('wrong root',()=>send(p,{signer:relayer,recipient:dest,relayerPk:relayer.publicKey,override:{root:arr(S.H(123n))}}),'unknown merkle root');
  r=await send(p,{signer:relayer,recipient:dest,relayerPk:relayer.publicKey});
  log('withdraw 3.9 CLAWD to fresh addr (relayed)',{sig:r.sig,cu:r.cu,size:r.size,err:r.err,destBalance:(await conn.getBalance(dest))/L});if(r.err){console.log(r.logs.join('\n'));process.exit(1);}
  // NEG: double spend (replay)
  await expectFail('double spend (replay)',()=>send(p,{signer:relayer,recipient:dest,relayerPk:relayer.publicKey}),'already in use');
  // NEG: double spend with fresh proof spending the same note
  tree.insert(p.input.outputCommitment[0]);tree.insert(p.input.outputCommitment[1]);
  const p2=await S.prove({tree,inputs:[found],outputs:[new S.Note({amount:0n,keypair:bob}),new S.Note({amount:0n,keypair:bob})],extAmount:-(4n*BigInt(L)),fee:0n,recipient:attacker,relayer:relayer.publicKey,encPubs:[bob.enc.publicKey,bob.enc.publicKey],wasm:W,zkey:Z});
  await expectFail('double spend (new proof, same note)',()=>send(p2,{signer:relayer,recipient:attacker,relayerPk:relayer.publicKey}),'already in use');
  // NEG: deposit cap
  const big=new S.Note({amount:101n*BigInt(L),keypair:alice});
  const pc=await S.prove({tree,inputs:[],outputs:[big,new S.Note({amount:0n,keypair:alice})],extAmount:101n*BigInt(L),fee:0n,recipient:user1.publicKey,relayer:user1.publicKey,encPubs:[alice.enc.publicKey,alice.enc.publicKey],wasm:W,zkey:Z});
  await expectFail('deposit above 100 CLAWD cap',()=>send(pc,{signer:user1,recipient:user1.publicKey,relayerPk:user1.publicKey}),'cap');
  const s2=await prog.account.pool.fetch(pool);log('pool',{nextIndex:s2.nextIndex,vault:(await conn.getBalance(vault))/L});
  fs.writeFileSync(`build/e2e-${new URL(RPC).hostname}.json`,JSON.stringify(results,null,1));process.exit(process.exitCode||0);
})().catch(e=>{console.error(e,e&&e.stack);process.exit(1)});
