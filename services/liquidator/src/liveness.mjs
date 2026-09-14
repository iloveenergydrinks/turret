export async function fetchLiveness(config,fetcher=fetch,now=Math.floor(Date.now()/1000)){
 const response=await fetcher(config.livenessUrl,{redirect:'error',cache:'no-store',signal:AbortSignal.timeout(5000)});
 if(!response.ok)throw new Error('Execution liveness unavailable');
 const p=await response.json();
 if(p.chainId!==config.chainId||p.vault?.toLowerCase()!==config.vault.toLowerCase()
  ||p.executionGate?.toLowerCase()!==config.executionGate.toLowerCase()
  ||!Number.isSafeInteger(p.validUntil)||p.validUntil<now+10||p.validUntil>now+45
  ||typeof p.encoded!=='string'||!/^0x(?:[a-fA-F0-9]{2}){64,512}$/.test(p.encoded))throw new Error('Execution liveness invalid');
 return p.encoded;
}
