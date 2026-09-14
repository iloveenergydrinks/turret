// Local subprocess fixture only. Production entrypoints never import this file.
import {readFileSync} from 'node:fs';
const control=new URL(process.env.STOCK_FIXTURE_CONTROL_URL),rpc=new URL(process.env.ALCHEMY_RPC_URL);
if(control.hostname!=='127.0.0.1'||rpc.hostname!=='127.0.0.1')throw new Error('Loopback fixture required');
const clockFile=process.env.STOCK_FIXTURE_CLOCK_FILE;
const fixtureNow=()=>JSON.parse(readFileSync(clockFile,'utf8')).now;
if(!Number.isSafeInteger(fixtureNow()))throw new Error('Fixture clock required');
Date.now=()=>fixtureNow()*1000;
const originalFetch=globalThis.fetch;
globalThis.fetch=(input,init)=>{
 const url=new URL(typeof input==='string'?input:input instanceof URL?input:input.url);
 if(url.origin==='https://data.alpaca.markets')return originalFetch(new URL(url.pathname+url.search,control),{signal:init?.signal});
 return originalFetch(input,init);
};
