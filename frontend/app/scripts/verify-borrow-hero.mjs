import assert from 'node:assert/strict';
const origin=process.argv[2]||'https://turret.capital';
let failed=false; const entrypoints=new Set();
for(const route of ['/','/borrow/p2p','/borrow/nfts','/borrow/pools']){
 const html=await (await fetch(origin+route)).text();
 const entries=[...html.matchAll(/<script[^>]+type="module"[^>]+src="([^"]+)"/g)].map(m=>m[1]);
 entries.forEach(entry=>entrypoints.add(entry));
 const js=(await Promise.all(entries.map(async path=>(await fetch(origin+path)).text()))).join('\n');
 const ready=js.includes('Two little knight mascots exchanging collateral and USDG through a loan cycle')&&js.includes('Loading Turret')&&js.includes('data-borrow-experience');
 console.log(`${ready?'PASS':'FAIL'} ${route}: animated hero and logo loader`);if(!ready)failed=true;
}
assert.equal(failed,false,'Every loan tab must ship the persistent hero and loader');
assert.equal(entrypoints.size,1,'All borrowing routes must use the same app entrypoint');
