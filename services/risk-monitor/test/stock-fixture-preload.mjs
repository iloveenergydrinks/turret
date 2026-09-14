// Explicit subprocess fixture only: never imported by either service entrypoint.
// No real provider credentials, signed external requests or target-chain writes.
const control=new URL(process.env.STOCK_FIXTURE_CONTROL_URL);
const rpc=new URL(process.env.ALCHEMY_RPC_URL);
if(control.hostname!=='127.0.0.1'||rpc.hostname!=='127.0.0.1')throw new Error('Loopback fixture required');
const offset=Number(process.env.STOCK_FIXTURE_CLOCK_OFFSET_MS);
if(!Number.isSafeInteger(offset))throw new Error('Fixture clock required');
const originalNow=Date.now;Date.now=()=>originalNow()+offset;
const originalFetch=globalThis.fetch;
globalThis.fetch=(input,init)=>{
 const url=new URL(typeof input==='string'?input:input instanceof URL?input:input.url);
 if(url.origin==='https://data.alpaca.markets')return originalFetch(new URL(`/snapshots${url.search}`,control),{signal:init?.signal});
 return originalFetch(input,init);
};
