import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createPublicClient,http,keccak256,parseAbi,formatUnits,decodeAbiParameters,encodeAbiParameters} from 'viem';
import {CANARY,artifact} from './stock-canary-rollout.mjs';
import {assertCanaryFunding} from './stock-canary-funding.mjs';

// Read-only production acceptance. There is no signer, broadcast, approval,
// subscription enrolment, position creation or configuration mutation here.
async function main() {
assert.ok(process.argv.slice(2).every(x=>['--funded','--execute','--repayment-reserve','--unpaused'].includes(x)),'Only --funded, --execute, --repayment-reserve and --unpaused are supported');
const funded=process.argv.includes('--funded'),reserveWithdrawn=process.argv.includes('--repayment-reserve');
const unpaused=process.argv.includes('--unpaused');
assert.ok(!reserveWithdrawn||funded,'Repayment reserve requires funded acceptance');
const expectedCash=funded?(reserveWithdrawn?249000000n:250000000n):0n;
const execute=process.argv.includes('--execute'),expectedMode=execute?'execute':'observe';
const m=JSON.parse(readFileSync(new URL('../../docs/security/evidence/2026-09-03/stock-canary-commissioning.json',import.meta.url)));
const load=id=>JSON.parse(execFileSync('railway',['variable','list','--service',id,'--json'],{encoding:'utf8',stdio:['ignore','pipe','pipe']}));
const riskEnv=load('86f47a92-a9fa-44c2-a7cd-3c6de5dcef7d'),keeperEnv=load('4e7e6c38-6872-43cf-86fc-1727bf08ad99');
const riskUrl='https://dockyard-stock-risk-production.up.railway.app',keeperUrl='https://dockyard-stock-keeper-production.up.railway.app',alertsUrl='https://dockyard-stock-alerts-production.up.railway.app';
const json=async(url,token)=>{
 const r=await fetch(url,{headers:token?{Authorization:`Bearer ${token}`}:{},signal:AbortSignal.timeout(15000),redirect:'error'});
 assert.equal(r.status,200,new URL(url).pathname);return r.json();
};
const same=(a,b)=>assert.equal(a.toLowerCase(),b.toLowerCase());
const [risk,keeper,alerts,capability]=await Promise.all([json(`${riskUrl}/status`,riskEnv.RISK_STATUS_TOKEN),json(`${keeperUrl}/status`,keeperEnv.KEEPER_STATUS_TOKEN),json(`${alertsUrl}/healthz`),json(`${alertsUrl}/capabilities`)]);
same(risk.vault,m.addresses.engine);assert.equal(risk.live,true);assert.equal(risk.mode,expectedMode);assert.equal(risk.ready,execute);
assert.equal(risk.lastError,null);assert.equal(risk.liveness.ok,true);assert.equal(risk.alertDelivery.delivered,true);
assert.equal(risk.incidents.filter(x=>x.severity==='critical').length,0);
same(keeper.snapshot.engine,m.addresses.engine);same(keeper.snapshot.pool,m.addresses.pool);same(keeper.snapshot.executionGate,m.riskMonitorCandidate.executionGate);
assert.equal(keeper.alive,true);assert.equal(keeper.snapshot.reconciled,true);assert.equal(keeper.snapshot.mode,expectedMode);assert.equal(keeper.operational,execute);
assert.equal(keeper.lastError,null);assert.equal(keeper.snapshot.openPositions,0);assert.equal(keeper.snapshot.totalDebt,'0');assert.equal(keeper.snapshot.availableLiquidity,String(expectedCash));
assert.equal(keeper.snapshot.incidents.filter(x=>x.severity==='critical').length,0);assert.equal(keeper.alertDelivery.delivered,true);
assert.ok(Date.now()-risk.lastCycle<60000&&Date.now()-keeper.snapshot.checkedAt<60000);
assert.ok(BigInt(keeper.snapshot.balances.usdg)>=55000000n&&BigInt(keeper.snapshot.balances.eth)>=1000000000000000n);
assert.deepEqual(alerts,{alive:true,monitorReady:true,deliveryReady:true});assert.equal(capability.protocol,'isolated');assert.equal(capability.email,true);same(capability.vault,m.addresses.engine);same(capability.collateral,CANARY.collateral);
for(const url of [`${riskUrl}/status`,`${keeperUrl}/status`])assert.equal((await fetch(url)).status,401);
assert.equal((await fetch(`${alertsUrl}/capabilities`,{headers:{Origin:'https://untrusted.example'}})).status,403);
const cors=await fetch(`${alertsUrl}/capabilities`,{headers:{Origin:'https://turret.capital'}});assert.equal(cors.headers.get('access-control-allow-origin'),'https://turret.capital');
assert.equal((await fetch(`${riskUrl}/stock/approvals/${m.addresses.engine}`)).status,execute?200:503,'Approval availability must match the expected worker mode');
const clients=[riskEnv.ALCHEMY_RPC_URL,'https://rpc.mainnet.chain.robinhood.com'].map(url=>createPublicClient({transport:http(url,{timeout:15000,retryCount:0}),cacheTime:0}));
assert.equal(await clients[0].getChainId(),4663);assert.equal(await clients[1].getChainId(),4663);
const c=clients[0],heads=await Promise.all(clients.map(c=>c.getBlock()));
for(const h of heads)assert.ok(Math.abs(Date.now()/1000-Number(h.timestamp))<30);
assert.ok((heads[0].number>heads[1].number?heads[0].number-heads[1].number:heads[1].number-heads[0].number)<=40n);
const common=heads[0].number<heads[1].number?heads[0].number:heads[1].number;
const head=await c.getBlock({blockNumber:common});
assert.equal((await clients[1].getBlock({blockNumber:head.number})).hash,head.hash);
const read=(address,name,type='uint256',args=[])=>c.readContract({address,abi:parseAbi([`function ${name}(${args.length?'address':''}) view returns(${type})`]),functionName:name,args,blockNumber:head.number});
const pins={...m.addresses,usdg:CANARY.usdg,collateral:CANARY.collateral,stockFeed:CANARY.stockFeed,stockGuard:m.frontendCandidate.secondary,executionGate:m.riskMonitorCandidate.executionGate,usdgPrimary:CANARY.usdgPrimary,usdgSecondary:CANARY.usdgSecondary};
await Promise.all(Object.entries(pins).map(async([key,address])=>assert.equal(keccak256(await c.getCode({address,blockNumber:head.number})),m.hashes[key])));
assert.equal(await read(m.addresses.engine,'riskPaused','bool'),!unpaused);
assert.equal(await read(m.addresses.pool,'outstandingPrincipal'),0n);
assert.equal(await read(m.addresses.pool,'debtLimit'),50000000n);
const oldVault='0x24043E8EFaB262f5198B87b5AA5A46Bc72AADDD8';
const balances={
 oldCash:await read(CANARY.usdg,'balanceOf','uint256',[oldVault]),
 poolCash:await read(CANARY.usdg,'balanceOf','uint256',[m.addresses.pool]),
 totalAssets:await read(m.addresses.pool,'totalAssets'),totalSupply:await read(m.addresses.pool,'totalSupply'),
 ownerShares:await read(m.addresses.pool,'balanceOf','uint256',[CANARY.owner]),
 maxWithdraw:await read(m.addresses.pool,'maxWithdraw','uint256',[CANARY.owner]),
};
let funding;
if(reserveWithdrawn){
 assert.equal(balances.oldCash,0n);assert.equal(balances.poolCash,expectedCash);assert.equal(balances.totalAssets,expectedCash);
 assert.equal(balances.totalSupply,expectedCash*1000000n);assert.equal(balances.ownerShares,balances.totalSupply);assert.equal(balances.maxWithdraw,expectedCash);
 assert.equal(await read(CANARY.usdg,'balanceOf','uint256',[CANARY.owner]),1000000n,'Owner holds the withdrawn repayment reserve');
 funding={oldVaultUSDG:'0',newPoolUSDG:'249',ownerRepaymentReserveUSDG:'1',fundingState:'owner-funded-reserve-withdrawn-paused'};
}else {
 funding=assertCanaryFunding(balances,{funded});
 if(unpaused&&funded)funding.fundingState='owner-funded-live';
}
assert.equal(await read(oldVault,'totalDebt'),0n);assert.equal(await read(oldVault,'paused','bool'),true);
const proof=await json(`${riskUrl}/liveness`);same(proof.vault,m.addresses.engine);same(proof.executionGate,m.riskMonitorCandidate.executionGate);
const gateAbi=artifact('DockyardExecutionGate').abi,engineAbi=artifact('DockyardStockCreditEngine').abi;
const before=await c.readContract({address:proof.executionGate,abi:gateAbi,functionName:'liveness'});
const price=(await c.simulateContract({address:m.addresses.engine,abi:engineAbi,functionName:'priceWithLiveness',args:[proof.encoded]})).result;
assert.ok(price>0n);
const parameters=[{type:'tuple',components:['observedAt','healthySince','validUntil','epoch'].map(name=>({name,type:'uint64'}))},{type:'bytes'}];
const [value,signature]=decodeAbiParameters(parameters,proof.encoded);
const tampered=encodeAbiParameters(parameters,[{...value,epoch:value.epoch+1n},signature]);
await assert.rejects(c.simulateContract({address:m.addresses.engine,abi:engineAbi,functionName:'priceWithLiveness',args:[tampered]}),e=>Boolean(e.walk?.(x=>x.name==='ContractFunctionRevertedError')));
assert.deepEqual(await c.readContract({address:proof.executionGate,abi:gateAbi,functionName:'liveness'}),before,'eth_call must not publish the proof');
console.log(JSON.stringify({checkedAt:new Date().toISOString(),chainId:4663,block:String(head.number),blockHash:head.hash,engine:m.addresses.engine,pool:m.addresses.pool,
 runtimePinsVerified:true,twoRpcConsensus:true,priceWithProductionProof:formatUnits(price,18),priceUnit:'USDG per AAPL Stock Token',tamperedProofRejected:true,chainStateUnchanged:true,
 risk:{mode:risk.mode,live:risk.live,borrowReady:risk.ready,marketCodes:risk.markets.map(x=>x.code),livenessHealthy:risk.liveness.ok,operatorDelivery:risk.alertDelivery.delivered},
 keeper:{mode:keeper.snapshot.mode,alive:keeper.alive,operational:keeper.operational,reconciled:true,openPositions:0,criticalIncidents:0,usdgBalance:formatUnits(BigInt(keeper.snapshot.balances.usdg),6),ethBalance:formatUnits(BigInt(keeper.snapshot.balances.eth),18)},
 alerts:{...alerts,identityVerified:true,unauthorizedOriginRejected:true},statusAuthenticationRequired:true,...funding,
 publicAdmission:unpaused?'active':'commissioning',borrowingEnabled:unpaused,broadcast:false}));
}
main().catch(error=>{
 const location=error.stack?.match(/verify-stock-canary-live\.mjs:\d+:\d+/)?.[0];
 const scalar=value=>['boolean','number','bigint'].includes(typeof value)||value===null?String(value):undefined;
 console.error(JSON.stringify({error:error.name,location,actual:scalar(error.actual),expected:scalar(error.expected),broadcast:false}));
 console.error('Production canary verification failed. Inspect service status and chain state; no transaction was sent. Private provider details withheld.');process.exitCode=1;
});
