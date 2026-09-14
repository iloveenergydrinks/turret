// Explicit local-fork subprocess fixture; never imported by a service entrypoint.
const rpc=new URL(process.env.KEEPER_RPC_URL);
if(rpc.hostname!=='127.0.0.1')throw new Error('Loopback fixture required');
const offset=Number(process.env.STOCK_FIXTURE_CLOCK_OFFSET_MS);
if(!Number.isSafeInteger(offset))throw new Error('Fixture clock required');
const realNow=Date.now;
Date.now=()=>realNow()+offset;
