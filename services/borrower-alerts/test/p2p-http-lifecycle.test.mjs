import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { test } from 'node:test';
import { createPublicClient, createWalletClient, defineChain, http, keccak256 } from 'viem';
import { createAlertsService } from '../src/server-runtime.mjs';

test('local HTTP consent, email/Telegram delivery and actual V1/V2/V3 loan events, extensions and deadline cancellation', {timeout:120000}, async t=>{
  const root=fileURLToPath(new URL('../../..',import.meta.url)),dir=mkdtempSync(join(tmpdir(),'p2p-alert-http-'));
  execFileSync(join(homedir(),'.foundry/bin/forge'),['build','--root',join(root,'contracts/p2p'),'--skip','test'],{stdio:'pipe'});
  const reserve=createServer();reserve.listen(0,'127.0.0.1');await once(reserve,'listening');const port=reserve.address().port;await new Promise(r=>reserve.close(r));
  const anvil=spawn(join(homedir(),'.foundry/bin/anvil'),['--host','127.0.0.1','--port',String(port),'--chain-id','31337','--silent'],{stdio:'ignore'});
  t.after(()=>{anvil.kill('SIGTERM');rmSync(dir,{recursive:true,force:true});});
  const rpc=`http://127.0.0.1:${port}`,chain=defineChain({id:31337,name:'P2P local alerts test',nativeCurrency:{name:'Test ETH',symbol:'ETH',decimals:18},rpcUrls:{default:{http:[rpc]}}});
  const client=createPublicClient({chain,transport:http(rpc,{retryCount:0}),pollingInterval:10});
  for(let i=0;;i++){try{assert.equal(await client.getChainId(),31337);break;}catch{if(i>100)throw new Error('Local Anvil failed');await new Promise(r=>setTimeout(r,30));}}
  assert.match(await client.request({method:'web3_clientVersion'}),/anvil/i);
  const [owner,lender,borrower]=await client.request({method:'eth_accounts'}),wallet=account=>createWalletClient({account,chain,transport:http(rpc)});
  const artifact=name=>JSON.parse(readFileSync(join(root,`contracts/p2p/out/${name}.sol/${name}.json`)));
  async function deploy(name,args){const a=artifact(name),hash=await wallet(owner).deployContract({abi:a.abi,bytecode:a.bytecode.object,args});const r=await client.waitForTransactionReceipt({hash});assert.equal(r.status,'success');return {address:r.contractAddress,abi:a.abi,block:r.blockNumber};}
  async function send(account,contract,fn,args=[]){const hash=await wallet(account).writeContract({address:contract.address,abi:contract.abi,functionName:fn,args});const r=await client.waitForTransactionReceipt({hash});assert.equal(r.status,'success');return r;}
  const cash=await deploy('LocalToken',['Local dollars','USDG',6]),collateral=await deploy('LocalToken',['Local silver','SLV',18]);
  const managers=[];
  for(const version of [1,2,3]){
    const manager=await deploy(version===1?'TurretP2PLending':`TurretP2PLendingV${version}`,[cash.address,collateral.address,owner,...(version===1?[100_000000n,1000_000000n,[lender]]:[])]);
    managers.push({...manager,version});
  }
  for(const account of [lender,borrower]){
    await send(owner,cash,'mint',[account,1000_000000n]);await send(owner,collateral,'mint',[account,1000n*10n**18n]);
    for(const manager of managers){await send(account,cash,'approve',[manager.address,2n**256n-1n]);await send(account,collateral,'approve',[manager.address,2n**256n-1n]);}
  }
  const registry={markets:await Promise.all(managers.map(async manager=>({version:manager.version,address:manager.address,chainId:31337,
    loanToken:cash.address,collateralToken:collateral.address,loanSymbol:'USDG',collateralSymbol:'SLV',loanDecimals:6,collateralDecimals:18,
    runtimeHash:keccak256(await client.getCode({address:manager.address})),startBlock:String(manager.block)})))};
  const registryPath=join(dir,'registry.json');writeFileSync(registryPath,JSON.stringify(registry));
  let now=Number((await client.getBlock()).timestamp)*1000,rejectDelivery=false,updates=[];
  const delivered=[];
  const sink=createServer(async(req,res)=>{let body='';for await(const part of req)body+=part;if(rejectDelivery){res.writeHead(503);res.end('{}');return;}delivered.push(JSON.parse(body));res.setHeader('content-type','application/json');res.end('{"id":"local-confirmation"}');});
  sink.listen(0,'127.0.0.1');await once(sink,'listening');t.after(()=>new Promise(r=>sink.close(r)));
  const deliveryUrl=`http://127.0.0.1:${sink.address().port}`;
  const env={ALERTS_PROTOCOL:'p2p',ALERTS_P2P_REGISTRY_PATH:registryPath,ALERTS_P2P_ALLOW_LOCAL:'true',ALERTS_P2P_CONFIRMATIONS:'1',
    ALERTS_APP_ORIGIN:'http://127.0.0.1:43210',ALERTS_DB_PATH:join(dir,'alerts.sqlite'),ALERTS_DATA_KEY:'ab'.repeat(32),ALERTS_RPC_URL:rpc,TELEGRAM_BOT_USERNAME:'turret_p2p_local_test'};
  const service=createAlertsService({env,client,now:()=>now,channels:{email:true,telegram:true},
    telegram:async(method,args)=>{assert.equal(method,'getUpdates');return {result:updates.filter(u=>u.update_id>=args.offset)};},
    send:async(channel,contact,text,id)=>{const result=await fetch(deliveryUrl,{method:'POST',body:JSON.stringify({channel,contact,text,id})});if(!result.ok)throw new Error('Local delivery rejection');}});
  service.server.listen(0,'127.0.0.1');await once(service.server,'listening');
  t.after(async()=>{service.stop();await new Promise(r=>service.server.close(r));service.store.close();});
  const base=`http://127.0.0.1:${service.server.address().port}`;
  async function request(path,body,session='',method){const result=await fetch(base+path,{method:method??(body?'POST':'GET'),headers:{...(body?{'content-type':'application/json'}:{}),...(session?{authorization:`Bearer ${session}`}:{})},...(body?{body:JSON.stringify(body)}:{})});const value=await result.json();assert.equal(result.status,200,JSON.stringify(value));return value;}
  async function mine(timestamp){if(timestamp!==undefined)await client.request({method:'evm_setNextBlockTimestamp',params:[Number(timestamp)]});await client.request({method:'evm_mine'});now=Number((await client.getBlock()).timestamp)*1000;}
  async function session(account){const challenge=await request('/challenge',{wallet:account});assert.match(challenge.message,/Turret P2P alert access/);const signature=await wallet(account).signMessage({message:challenge.message});return (await request('/session',{id:challenge.id,signature})).session;}
  await service.tick();assert.equal((await request('/capabilities')).protocol,'p2p');
  const lenderSession=await session(lender),borrowerSession=await session(borrower);
  await request('/subscriptions',{channel:'email',email:'local-lender@example.test'},lenderSession);await service.tick();
  assert.equal(delivered.length,1);assert.match(delivered[0].text,/Confirm Turret P2P/);
  const emailToken=delivered[0].text.match(/#([a-f0-9]{64})/)[1];await request('/verify',{token:emailToken});
  const telegram=await request('/subscriptions',{channel:'telegram'},borrowerSession);const telegramToken=new URL(telegram.url).searchParams.get('start');
  updates.push({update_id:1,message:{chat:{id:123,type:'private'},text:`/start ${telegramToken}`}});await service.tick();
  assert.equal((await request('/subscriptions',undefined,borrowerSession))[0].channel,'telegram');
  delivered.length=0;
  async function open(manager,id){const expires=BigInt(Math.floor(now/1000))+1800n;
    await send(lender,manager,'createOffer',[borrower,10_000000n,10n**18n,1_000000n,BigInt(manager.version===1?7:1)*86400n,expires]);
    await send(borrower,manager,'acceptOffer',[BigInt(id)]);await mine();await service.tick();}
  for(const manager of managers)await open(manager,1);
  assert.equal(delivered.filter(row=>row.text.includes('Loan accepted')).length,6,'both consenting parties receive each V1/V2/V3 acceptance');
  assert.deepEqual(new Set(delivered.map(row=>row.channel)),new Set(['email','telegram']));
  for(const manager of managers.slice(0,2)){await send(borrower,manager,'repay',[1n]);await mine();await service.tick();}
  assert.equal(delivered.filter(row=>row.text.includes('Loan repaid')).length,4);
  const v3=managers[2],read=(fn,args=[])=>client.readContract({address:v3.address,abi:v3.abi,functionName:fn,args});
  const oldDeadline=await read('repaymentDeadline',[1n]);
  rejectDelivery=true;await mine(oldDeadline-3000n);await service.tick();
  assert.equal(service.store.all('outbox').filter(row=>row.kind==='p2p-deadline').length,2);
  const newDeadline=oldDeadline+86400n,expires=oldDeadline-1000n;
  await send(borrower,v3,'proposeExtension',[1n,newDeadline,expires]);await mine();rejectDelivery=false;await service.tick();
  assert.equal(delivered.filter(row=>row.text.includes('Deadline extension proposed')).length,1);
  assert.equal(delivered.find(row=>row.text.includes('Deadline extension proposed')).channel,'email');
  await send(lender,v3,'acceptExtension',[1n,1n,oldDeadline,newDeadline,expires]);await mine();await service.tick();
  assert.equal(service.store.all('outbox').filter(row=>row.kind==='p2p-deadline'&&row.deadline===Number(oldDeadline)).length,0,'obsolete failed notices cancelled after extension');
  assert.equal(delivered.filter(row=>row.text.includes('Deadline extension agreed')).length,2);
  await mine(newDeadline-3000n);await service.tick();
  assert.equal(delivered.filter(row=>row.text.includes('within one hour')).length,2,'only new deadline gets delivered');
  await send(borrower,v3,'repay',[1n]);await mine();await service.tick();
  assert.equal(delivered.filter(row=>row.text.includes('Loan repaid')).length,6);
  await open(v3,2);const defaultDeadline=await read('repaymentDeadline',[2n]);await mine(defaultDeadline+1n);await service.tick();
  assert.equal(delivered.filter(row=>row.text.includes('Final repayment deadline passed')).length,2);
  await send(lender,v3,'claimDefault',[2n]);await mine();await service.tick();
  assert.equal(delivered.filter(row=>row.text.includes('Default settled')).length,2);
  // Time travel intentionally expires the management session. Reauthenticate for deletion.
  await request('/subscriptions',{channel:'email'},await session(lender),'DELETE');
  const before=delivered.length;await open(v3,3);
  assert.deepEqual(delivered.slice(before).map(row=>row.channel),['telegram']);
  const count=delivered.length;await service.tick();assert.equal(delivered.length,count,'confirmed events do not replay');
  assert.equal((await fetch(base+'/capabilities',{headers:{origin:'https://unrelated.example'}})).status,403);
});
