import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {createServer as createHttpServer} from 'node:http';
import {createRequire} from 'node:module';
import {privateKeyToAccount} from '../src/deps.mjs';
import {makeProof,roundHash} from '../src/policy.mjs';
const require=createRequire(new URL('../../liquidator/package.json',import.meta.url));
const {createPublicClient,createWalletClient,defineChain,http,keccak256}=require('viem');
const artifact=(folder,name)=>JSON.parse(readFileSync(new URL(`../../../contracts/out/${folder}/${name}.json`,import.meta.url)));
test('JavaScript monitor approvals execute against the actual pilot EVM bytecode',async t=>{
 const socket=createServer();await new Promise(resolve=>socket.listen(0,'127.0.0.1',resolve));const port=socket.address().port;await new Promise(resolve=>socket.close(resolve));
 const anvil=spawn('anvil',['--silent','--chain-id','4663','--port',String(port)],{stdio:'ignore'});t.after(()=>anvil.kill());
 const owner=privateKeyToAccount(`0x${'1'.padStart(64,'0')}`),guardian=privateKeyToAccount(`0x${'2'.padStart(64,'0')}`);
 const chain=defineChain({id:4663,name:'Local pilot verification',nativeCurrency:{name:'Ether',symbol:'ETH',decimals:18},rpcUrls:{default:{http:[`http://127.0.0.1:${port}`]}}});
 const client=createPublicClient({chain,transport:http(chain.rpcUrls.default.http[0]),cacheTime:0}),wallet=createWalletClient({account:owner,chain,transport:http(chain.rpcUrls.default.http[0])});
 for(let i=0;i<50;i++){try{await client.getChainId();break;}catch{await new Promise(r=>setTimeout(r,100));}}
 await client.request({method:'anvil_setBalance',params:[owner.address,'0x3635c9adc5dea00000']});
 const deploy=async(file,name,args)=>{const a=artifact(file,name);const hash=await wallet.deployContract({abi:a.abi,bytecode:a.bytecode.object,args});return {address:(await client.waitForTransactionReceipt({hash})).contractAddress,abi:a.abi};};
 const write=async(c,functionName,args=[])=>client.waitForTransactionReceipt({hash:await wallet.writeContract({...c,functionName,args})});
 const read=(c,functionName,args=[])=>client.readContract({...c,functionName,args});
 const usdFixture=await deploy('DockyardUSDGCreditVault.t.sol','DockyardMockERC20',['USDG','USDG',6]);
 // Local-only canonical address fixture for the worker's hard USDG identity check.
 const usd={address:'0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168',abi:usdFixture.abi};
 await client.request({method:'anvil_setCode',params:[usd.address,await client.getCode({address:usdFixture.address})]});
 const stock=await deploy('DockyardOracleV2.t.sol','ScaledStockFixture',[]);
 const primary=await deploy('DockyardUSDGCreditVault.t.sol','DockyardMockOracle',[8,10000000000n]);
 const guard=await deploy('DockyardChainlinkGuard.sol','DockyardChainlinkGuard',[stock.address,primary.address,guardian.address]);
 const vault=await deploy('DockyardUSDGCreditVaultPilot.sol','DockyardUSDGCreditVaultPilot',[usd.address,owner.address]);
 await write(vault,'addMarket',[stock.address,primary.address,guard.address,50000000n,3000,4000,500,200]);
 await write(vault,'setBorrowerAllowed',[owner.address,true]);
 await t.test('real worker starts in observe mode with authenticated status and no borrowing approvals',async()=>{
  const webhook=createHttpServer((req,res)=>{req.resume();res.end('{}');});await new Promise(resolve=>webhook.listen(0,'127.0.0.1',resolve));
  const listener=createServer();await new Promise(resolve=>listener.listen(0,'127.0.0.1',resolve));const workerPort=listener.address().port;await new Promise(resolve=>listener.close(resolve));
  const directory=mkdtempSync(`${tmpdir()}/dockyard-risk-test-`),token='local-test-status-token-'.repeat(3);
  const manifest={kind:'chainlink-guarded-pilot',status:'receipt-verified',marketDataVerified:false,chainId:4663,vault:vault.address,vaultCodeHash:keccak256(await client.getCode({address:vault.address})),owner:owner.address,keeper:'0x3333333333333333333333333333333333333333',guardian:guardian.address,startBlock:1,markets:[{symbol:'AAPL',collateral:stock.address,primaryOracle:primary.address,adapter:guard.address,adapterCodeHash:keccak256(await client.getCode({address:guard.address}))}]};
  const worker=spawn(process.execPath,[new URL('../src/main.mjs',import.meta.url).pathname],{env:{...process.env,RISK_MODE:'observe',RISK_MANIFEST_JSON:JSON.stringify(manifest),ALCHEMY_RPC_URL:chain.rpcUrls.default.http[0],RISK_STATUS_TOKEN:token,RISK_DATA_DIR:directory,RISK_APP_ORIGIN:'http://localhost',RISK_ALERT_WEBHOOK_URL:`http://127.0.0.1:${webhook.address().port}`,PORT:String(workerPort)},stdio:'ignore'});
  try{
   let health;
   for(let i=0;i<100;i++){try{const r=await fetch(`http://127.0.0.1:${workerPort}/healthz`);if(r.ok){health=await r.json();break;}}catch{}await new Promise(r=>setTimeout(r,100));}
   assert.equal(health?.live,true);assert.equal(health?.ready,false);
   assert.equal((await fetch(`http://127.0.0.1:${workerPort}/status`)).status,401);
   const status=await (await fetch(`http://127.0.0.1:${workerPort}/status`,{headers:{Authorization:`Bearer ${token}`}})).json();
   assert.equal(status.mode,'observe');assert.equal(status.lastError,null);assert.equal(status.markets.length,1);
   assert.equal((await fetch(`http://127.0.0.1:${workerPort}/approvals/${stock.address}`)).status,503);
  }finally{
   const stopped=new Promise(resolve=>worker.once('exit',resolve));worker.kill('SIGTERM');await stopped;
   await new Promise(resolve=>webhook.close(resolve));rmSync(directory,{recursive:true,force:true});
  }
 });
 await client.request({method:'evm_increaseTime',params:[121]});await client.request({method:'evm_mine',params:[]});
 await write(primary,'setAnswer',[10000000000n]);
 const proof=async()=>{
  const now=Number((await client.getBlock()).timestamp),roundId=await read(primary,'roundId');
  return makeProof(guardian,guard.address,{ok:true,roundId,roundHash:roundHash(roundId,(await read(primary,'answer'))*10n**10n,await read(primary,'updatedAt')),sourceTime:now,sessionOpen:now-300,sessionClose:now+3600},{epoch:await read(guard,'epoch'),recoveryAt:await read(guard,'recoveryAt')},now);
 };
 await write(guard,'submitHealth',[(await proof()).encoded]);await write(vault,'setMarketEnabled',[stock.address,true]);await write(vault,'unpause');
 await write(usd,'mint',[owner.address,200000000n]);await write(usd,'approve',[vault.address,200000000n]);await write(vault,'fund',[100000000n]);
 await write(stock,'mint',[owner.address,10n**18n]);await write(stock,'approve',[vault.address,10n**18n]);
 await t.test('monitor EIP-712 proof enables atomic deposit and borrow',async()=>{
  const receipt=await write(vault,'depositAndBorrowChecked',[stock.address,10n**18n,20000000n,(await proof()).encoded]);
  assert.equal(receipt.status,'success');assert.deepEqual(await read(vault,'positions',[stock.address,owner.address]),[10n**18n,20100000n]);
  console.log(`Pilot checked borrow gas: ${receipt.gasUsed}`);
 });
 await t.test('old proof expires and never becomes valid after replay',async()=>{
  const p=await proof();await client.request({method:'evm_increaseTime',params:[46]});await client.request({method:'evm_mine',params:[]});
  await assert.rejects(client.simulateContract({...guard,functionName:'submitHealth',args:[p.encoded]}));
 });
 await t.test('stopping approval publication does not stop repayment',async()=>{
  await write(vault,'pause');const receipt=await write(vault,'repayAllAndWithdrawCollateral',[stock.address,owner.address]);
  assert.equal(receipt.status,'success');assert.equal(await read(vault,'totalDebt'),0n);assert.equal(await read(stock,'balanceOf',[owner.address]),10n**18n);
 });
});
