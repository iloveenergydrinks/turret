import {readFileSync,writeFileSync} from 'node:fs';
import assert from 'node:assert/strict';
import {createPublicClient,http,parseAbi,encodeFunctionData,keccak256} from '../src/deps.mjs';
import {keeperReady} from '../src/keeper-health.mjs';
const m=JSON.parse(readFileSync('contracts/utils/assets/test_output/dockyard-pilot-heartbeat-deployed.json'));
const c=createPublicClient({transport:http(process.env.ALCHEMY_RPC_URL,{timeout:12000,retryCount:0}),cacheTime:0});
assert.equal(await c.getChainId(),4663);const head=await c.getBlock();
const abi=parseAbi(['function owner() view returns(address)','function paused() view returns(bool)','function totalDebt() view returns(uint256)','function availableLiquidity() view returns(uint256)','function globalDebtCeiling() view returns(uint256)','function balanceOf(address) view returns(uint256)','function allowance(address,address) view returns(uint256)','function withdrawLiquidity(address,uint256)','function approve(address,uint256) returns(bool)','function fund(uint256)']);
const old='0x576c510e9A268B06448f67598B7BF1ed33388e20',usdg='0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';
const read=(address,name,args=[])=>c.readContract({address,abi,functionName:name,args,blockNumber:head.number});
const report={checkedAt:new Date().toISOString(),block:head.number,vault:m.vault,checks:{}};
assert.equal(keccak256(await c.getCode({address:m.vault,blockNumber:head.number})),m.vaultCodeHash);
assert.equal(await read(old,'paused'),true);assert.equal(await read(old,'totalDebt'),0n);
assert.equal(await read(m.vault,'paused'),true);assert.equal(await read(m.vault,'totalDebt'),0n);assert.equal(await read(m.vault,'availableLiquidity'),250000000n);assert.equal(await read(m.vault,'globalDebtCeiling'),250000000n);
assert.equal(await read(usdg,'allowance',[m.owner,m.vault]),0n);
report.balances={oldVaultUsdg:await read(old,'availableLiquidity'),newVaultUsdg:await read(m.vault,'availableLiquidity'),keeperUsdg:await read(usdg,'balanceOf',[m.keeper]),keeperEth:await c.getBalance({address:m.keeper,blockNumber:head.number}),guardianEth:await c.getBalance({address:m.guardian,blockNumber:head.number})};
assert.ok(report.balances.keeperUsdg>=250000000n);assert.ok(report.balances.keeperEth>=1000000000000000n);assert.ok(report.balances.guardianEth>=2000000000000000n);
report.checks.cappedLiquidityAndGasFunded=true;
report.migration=[];
for(const [hash,to,fn,args] of [
 ['0xd022496c32458677537edf4cbe270b68ad9aefd2ad5a6dd735fdd65550473230',old,'withdrawLiquidity',[m.owner,250000000n]],
 ['0x106c8f59fffc6253d940291f14d5964af4e2896b6a46df7cbd9397b4bd2d7252',usdg,'approve',[m.vault,250000000n]],
 ['0xc8ea11589993688747e07d674a5aca064b3736ac27d8d37d89952187d647e888',m.vault,'fund',[250000000n]],
]){
 const r=await c.getTransactionReceipt({hash}),t=await c.getTransaction({hash});assert.equal(r.status,'success');assert.equal(t.from.toLowerCase(),m.owner.toLowerCase());assert.equal(t.to.toLowerCase(),to.toLowerCase());assert.equal(t.input.toLowerCase(),encodeFunctionData({abi,functionName:fn,args}).toLowerCase());assert.equal(t.value,0n);assert.equal((await c.getBlock({blockNumber:r.blockNumber})).hash,r.blockHash);
 report.migration.push({hash,to,action:fn,block:r.blockNumber,gasCost:r.gasUsed*r.effectiveGasPrice});
}
report.checks.migrationReceiptsVerified=true;
async function get(url,token){const r=await fetch(url,{headers:{Origin:'https://turret.capital',...(token?{Authorization:`Bearer ${token}`}:{})},redirect:'error',signal:AbortSignal.timeout(15000)});assert.equal(r.status,200);return r.json();}
const keeper=await get('https://dockyard-keeper-production.up.railway.app/status',process.env.KEEPER_STATUS_TOKEN);
assert.equal(keeperReady(keeper,m),true);report.keeper=keeper;report.checks.keeperOperational=true;
const risk=await get('https://dockyard-risk-monitor-production.up.railway.app/status',process.env.RISK_STATUS_TOKEN);
assert.equal(risk.vault.toLowerCase(),m.vault.toLowerCase());assert.equal(risk.mode,'observe');assert.equal(risk.live,true);assert.equal(risk.lastError,null);assert.equal(risk.alertDelivery.transport,'resend');assert.equal(risk.markets.length,10);assert.ok(risk.markets.every(x=>x.maxPriceAgeSeconds===86400));report.risk=risk;
const alerts=await get('https://dockyard-borrower-alerts-production.up.railway.app/capabilities');assert.equal(alerts.vault.toLowerCase(),m.vault.toLowerCase());assert.equal(alerts.email,true);assert.equal(alerts.monitorReady,true);report.borrowerAlerts=alerts;
for(const base of ['https://dockyard-keeper-production.up.railway.app','https://dockyard-risk-monitor-production.up.railway.app'])assert.equal((await fetch(base+'/status')).status,401);
assert.equal((await fetch('https://dockyard-risk-monitor-production.up.railway.app/approvals/'+m.markets[0].collateral)).status,503);
report.checks.servicesBoundToReplacement=true;report.checks.unqualifiedBorrowingBlocked=true;
const emails=await fetch('https://api.resend.com/emails',{headers:{Authorization:`Bearer ${process.env.RESEND_API_KEY}`},signal:AbortSignal.timeout(15000)});assert.ok(emails.ok);
report.operatorEmails=(await emails.json()).data.filter(e=>e.subject?.startsWith('Dockyard keeper:')&&Date.parse(e.created_at)>Date.parse('2026-09-02T21:49:00Z')).map(({id,subject,created_at,last_event})=>({id,subject,created_at,last_event}));
assert.ok(report.operatorEmails.some(e=>e.last_event==='delivered'));report.checks.operatorEmailDelivered=true;
assert.equal((await c.getBlock({blockNumber:head.number})).hash,head.hash);
report.publicLaunchReady=false;report.pending=['Fresh in-session market-data qualification','Production market-data-use terms','Allowlisted real-chain borrow/repay canary','Sequencer recovery and collateral-exit risk review before public lending'];
writeFileSync('docs/security/evidence/2026-09-02/pilot-heartbeat-rollout-verification.json',JSON.stringify(report,(_,v)=>typeof v==='bigint'?v.toString():v,2)+'\n');
console.log(JSON.stringify({checkedAt:report.checkedAt,vault:m.vault,checks:report.checks,balances:report.balances,publicLaunchReady:false},(_,v)=>typeof v==='bigint'?v.toString():v));
