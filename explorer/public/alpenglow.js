(()=>{const rpc=(m,p)=>fetch('/api/rpc',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({method:m,params:p||[]})}).then(r=>r.json()).then(j=>j.result);
const $=id=>document.getElementById(id),f=n=>Number(n).toLocaleString('en-US');
async function tick(){try{const[a,b,g]=await Promise.all([rpc('getSlot',[{commitment:'processed'}]),rpc('getSlot',[{commitment:'finalized'}]),rpc('getGenesisHash')]);
if(a!=null)$('s-proc').textContent=f(a);if(b!=null)$('s-fin').textContent=f(b);if(a!=null&&b!=null)$('s-lag').textContent=f(Math.max(0,a-b));
if(g)$('gh').textContent=g;$('s-meta').textContent='Live from the RPC · updated '+new Date().toLocaleTimeString();}catch(e){$('s-meta').textContent='RPC unavailable, retrying…'}}
tick();setInterval(tick,4000);})();
