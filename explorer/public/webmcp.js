// WebMCP: expose read-only clawd chain tools to in-browser agents (navigator.modelContext). Safe no-op if unsupported.
(function(){
  const RPC='https://rpc.clawdchain.trade', FALLBACK='https://clawd-validator-production.up.railway.app', SITE='https://clawdchain.trade', LAM=1e9;
  async function rpc(method,params=[]){for(const u of[RPC,FALLBACK]){try{const j=await (await fetch(u,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})})).json();if(j.error)throw new Error(j.error.message);return j.result}catch(e){if(u===FALLBACK)throw e}}}
  const txt=o=>({content:[{type:'text',text:JSON.stringify(o,null,2)}]});
  const obj=(p,r=[])=>({type:'object',properties:p,required:r});
  const tools=[
    {name:'get_slot',description:'Current clawd slot',inputSchema:obj({}),execute:async()=>txt({slot:await rpc('getSlot',[{commitment:'confirmed'}])})},
    {name:'network_stats',description:'clawd epoch, height, tx count, version, genesis',inputSchema:obj({}),execute:async()=>{const[e,v,g]=await Promise.all([rpc('getEpochInfo'),rpc('getVersion'),rpc('getGenesisHash')]);return txt({...e,version:v['solana-core'],genesisHash:g})}},
    {name:'get_balance',description:'CLAWD balance of an address',inputSchema:obj({address:{type:'string'}},['address']),execute:async({address})=>{const b=await rpc('getBalance',[address]);return txt({address,clawd:b.value/LAM})}},
    {name:'get_account',description:'Account info and recent signatures',inputSchema:obj({address:{type:'string'}},['address']),execute:async({address})=>{const[i,s]=await Promise.all([rpc('getAccountInfo',[address,{encoding:'base64',dataSlice:{offset:0,length:0}}]),rpc('getSignaturesForAddress',[address,{limit:10}])]);return txt({address,account:i.value,recent:s,explorer:SITE+'/address/'+address})}},
    {name:'get_transaction',description:'Transaction by signature',inputSchema:obj({signature:{type:'string'}},['signature']),execute:async({signature})=>txt(await rpc('getTransaction',[signature,{encoding:'jsonParsed',maxSupportedTransactionVersion:0,commitment:'confirmed'}]))},
    {name:'get_block',description:'Block by slot (signatures only)',inputSchema:obj({slot:{type:'integer'}},['slot']),execute:async({slot})=>txt(await rpc('getBlock',[slot,{transactionDetails:'signatures',rewards:false,maxSupportedTransactionVersion:0,commitment:'confirmed'}]))},
    {name:'recent_blocks',description:'Latest confirmed block slots',inputSchema:obj({limit:{type:'integer',maximum:20}}),execute:async({limit=5}={})=>{const s=await rpc('getSlot',[{commitment:'confirmed'}]);const b=await rpc('getBlocks',[Math.max(0,s-40),s,{commitment:'confirmed'}]);return txt(b.slice(-limit).reverse())}},
    {name:'search',description:'Open explorer for a slot, signature or address',inputSchema:obj({query:{type:'string'}},['query']),execute:async({query})=>{const q=String(query).trim();const path=/^\d+$/.test(q)?'/block/'+q:q.length>=80?'/tx/'+q:'/address/'+q;return txt({url:SITE+path})}},
    {name:'faucet_info',description:'clawd faucet limits and flow (informational; does not request funds)',inputSchema:obj({}),execute:async()=>txt({url:'https://faucet.clawdchain.trade',perWallet:5,perIp:10,window:'24h',pow:'browser proof of work, solved by the human on the faucet page'})},
  ];
  try{const mc=navigator.modelContext;if(!mc)return;
    if(typeof mc.provideContext==='function')mc.provideContext({tools});
    else if(typeof mc.registerTool==='function')tools.forEach(t=>{try{mc.registerTool(t)}catch(e){}});
  }catch(e){}
})();
