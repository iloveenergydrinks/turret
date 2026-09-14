// Test-only preload, excluded from production images. Public signed historical
// packets and local email responses are fixtures; no external writes are allowed.
if(process.env.DOCKYARD_LOCAL_SERVICE_FIXTURE!=='true')throw Error('Local fixture opt-in required');
const fixture=new URL(process.env.TEST_ORACLE_FIXTURE_URL),rpc=new URL(process.env.ORACLE_RPC_URL);
const status=process.env.API3_ORACLE_STATUS_URL?new URL(process.env.API3_ORACLE_STATUS_URL):null;
for(const url of [fixture,rpc,...(status?[status]:[])])
  if(url.protocol!=='http:'||url.hostname!=='127.0.0.1')throw Error('Loopback fixture required');
const epoch=Number(process.env.TEST_API3_CLOCK_MS),launched=Number(process.env.TEST_API3_REAL_START_MS),realNow=Date.now;
if(!Number.isSafeInteger(epoch)||epoch<=0||!Number.isSafeInteger(launched)||launched<=0)throw Error('Fixture clock required');
// Include child startup time so separately launched processes share one clock.
Date.now=()=>epoch+realNow()-launched;
const originalFetch=globalThis.fetch;
globalThis.fetch=(input,options)=>{
  const url=new URL(typeof input==='string'||input instanceof URL?input:input.url);
  if(url.origin==='https://signed-api.api3.org'&&/^\/public\/0x[\da-f]{40}$/i.test(url.pathname))
    return originalFetch(new URL('/api3/'+url.pathname.split('/').at(-1),fixture),options);
  if(url.href==='https://api.resend.com/emails')return originalFetch(new URL('/emails',fixture),options);
  if(url.origin===rpc.origin||url.origin===fixture.origin||url.href===status?.href)return originalFetch(input,options);
  throw Error('Nonlocal request blocked by API3 service fixture');
};
