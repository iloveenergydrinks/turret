// Test-only Node preload. Not included in the production Docker image.
// Never use real credentials: all price/email requests stay on this loopback fixture.
if(process.env.DOCKYARD_LOCAL_SERVICE_FIXTURE!=='true')throw Error('Local fixture opt-in required');
const fixture=new URL(process.env.TEST_ORACLE_FIXTURE_URL),rpc=new URL(process.env.ORACLE_RPC_URL);
for(const url of [fixture,rpc,...(process.env.ISOLATED_ORACLE_STATUS_URL?[new URL(process.env.ISOLATED_ORACLE_STATUS_URL)]:[])])
  if(url.protocol!=='http:'||url.hostname!=='127.0.0.1')throw Error('Loopback fixture required');
const originalFetch=globalThis.fetch;
const routes=new Map([
  ['https://pyth.dourolabs.app/v1/symbols','/symbols'],
  ['https://pyth-lazer.dourolabs.app/v1/latest_price','/prices'],
  ['https://api.resend.com/emails','/emails'],
]);
globalThis.fetch=(input,options)=>{
  const url=new URL(typeof input==='string'||input instanceof URL?input:input.url);
  const route=routes.get(url.href);
  if(route)return originalFetch(new URL(route,fixture),options);
  if(url.origin===rpc.origin||url.origin===fixture.origin
    ||url.href===process.env.ISOLATED_ORACLE_STATUS_URL)return originalFetch(input,options);
  throw Error('Nonlocal request blocked by service fixture');
};
