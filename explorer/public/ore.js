(()=>{const rpc=(m,p)=>fetch('/api/rpc',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({method:m,params:p||[]})}).then(r=>r.json()).then(j=>j.result);
const $=id=>document.getElementById(id),f=n=>Number(n).toLocaleString('en-US');
async function tick(){try{const[s,a,sl]=await Promise.all([rpc('getTokenSupply',['5e2NA8PVis1QCx3aT5qmdFDW3KFJFnpY7WCf26Ds8XT7']),rpc('getAccountInfo',['2QHkgHHPxFUak2MC16QvB6zh7aeKQn1ehEn1sEsTaaCP',{encoding:'base64'}]),rpc('getSlot',[{commitment:'finalized'}])]);
if(s&&s.value)$('o-sup').textContent=f(s.value.amount)+' grains';$('o-prog').textContent=a&&a.value&&a.value.executable?'live ✓':'not found';if(sl!=null)$('o-slot').textContent=f(sl);
$('o-meta').textContent='Live from the RPC · updated '+new Date().toLocaleTimeString();}catch(e){$('o-meta').textContent='RPC unavailable, retrying…'}}
tick();setInterval(tick,4000);})();
