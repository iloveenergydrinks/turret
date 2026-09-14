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

test('NFT HTTP consent and real local loan lifecycle, reminders, settlement, and persistent restart', {timeout:120000}, async t=>{
  const root=fileURLToPath(new URL('../../..',import.meta.url)),dir=mkdtempSync(join(tmpdir(),'p2p-alert-http-'));
  execFileSync(join(homedir(),'.foundry/bin/forge'),['build','--root',join(root,'contracts/p2p')],{stdio:'pipe'});
  const reserve=createServer();reserve.listen(0,'127.0.0.1');await once(reserve,'listening');const port=reserve.address().port;await new Promise(r=>reserve.close(r));
  const anvil=spawn(join(homedir(),'.foundry/bin/anvil'),['--host','127.0.0.1','--port',String(port),'--chain-id','31337','--silent'],{stdio:'ignore'});
  t.after(()=>{anvil.kill('SIGTERM');rmSync(dir,{recursive:true,force:true});});
  const rpc=`http://127.0.0.1:${port}`,chain=defineChain({id:31337,name:'P2P local alerts test',nativeCurrency:{name:'Test ETH',symbol:'ETH',decimals:18},rpcUrls:{default:{http:[rpc]}}});
  const client=createPublicClient({chain,transport:http(rpc,{retryCount:0}),pollingInterval:10});
  for(let i=0;;i++){try{assert.equal(await client.getChainId(),31337);break;}catch{if(i>100)throw new Error('Local Anvil failed');await new Promise(r=>setTimeout(r,30));}}
  assert.match(await client.request({method:'web3_clientVersion'}),/anvil/i);
  const [owner,lender,borrower]=await client.request({method:'eth_accounts'}),wallet=account=>createWalletClient({account,chain,transport:http(rpc)});
  const artifact=name=>JSON.parse(readFileSync(join(root,`contracts/p2p/out/${name==='TestNFT'?'TurretNFTLending.t':name}.sol/${name}.json`)));
  async function deploy(name,args){const a=artifact(name),hash=await wallet(owner).deployContract({abi:a.abi,bytecode:a.bytecode.object,args});const r=await client.waitForTransactionReceipt({hash});assert.equal(r.status,'success');return {address:r.contractAddress,abi:a.abi,block:r.blockNumber};}
  async function send(account,contract,fn,args=[]){const hash=await wallet(account).writeContract({address:contract.address,abi:contract.abi,functionName:fn,args});const r=await client.waitForTransactionReceipt({hash});assert.equal(r.status,'success');return r;}
  const cash=await deploy('LocalToken',['Local dollars','USDG',6]),nft=await deploy('TestNFT',[]);
  const manager=await deploy('TurretNFTLending',[cash.address,owner]);
  await send(owner,manager,'setCollectionAllowed',[nft.address,true]);await send(owner,manager,'setNewLoansPaused',[false]);
  for(const account of [lender,borrower]){await send(owner,cash,'mint',[account,1000_000000n]);await send(account,cash,'approve',[manager.address,1000_000000n]);}
  for(const id of [1n,2n,3n]){await send(owner,nft,'mint',[borrower,id]);await send(borrower,nft,'approve',[manager.address,id]);}
  const registry={version:1,address:manager.address,chainId:31337,loanToken:cash.address,loanDecimals:6,
    runtimeHash:keccak256(await client.getCode({address:manager.address})),startBlock:String(manager.block)};
  const registryPath=join(dir,'registry.json');writeFileSync(registryPath,JSON.stringify(registry));
  let now=Number((await client.getBlock()).timestamp)*1000,rejectDelivery=false;
  const delivered=[];
  const env={ALERTS_PROTOCOL:'nft',ALERTS_NFT_REGISTRY_PATH:registryPath,ALERTS_NFT_ALLOW_LOCAL:'true',ALERTS_NFT_CONFIRMATIONS:'1',
    ALERTS_APP_ORIGIN:'http://127.0.0.1:43210',ALERTS_DB_PATH:join(dir,'alerts.sqlite'),ALERTS_DATA_KEY:'ab'.repeat(32),ALERTS_RPC_URL:rpc};
  const options={env,client,now:()=>now,channels:{email:true,telegram:false},
    send:async(channel,contact,text,id)=>{if(rejectDelivery)throw Error('Synthetic provider interruption');delivered.push({channel,contact,text,id});}};
  let service=createAlertsService(options);
  await new Promise(r=>service.server.listen(0,'127.0.0.1',r));
  t.after(async()=>{service.stop();await new Promise(r=>service.server.close(r));service.store.close();});
  const base=()=>`http://127.0.0.1:${service.server.address().port}`;
  async function request(path,body,session='',method){const result=await fetch(base()+path,{method:method??(body?'POST':'GET'),headers:{...(body?{'content-type':'application/json'}:{}),...(session?{authorization:`Bearer ${session}`}:{})},...(body?{body:JSON.stringify(body)}:{})});const value=await result.json();assert.equal(result.status,200,JSON.stringify(value));return value;}
  async function mine(timestamp){if(timestamp!==undefined)await client.request({method:'evm_setNextBlockTimestamp',params:[Number(timestamp)]});await client.request({method:'evm_mine'});now=Number((await client.getBlock()).timestamp)*1000;}
  async function session(account){const challenge=await request('/challenge',{wallet:account});assert.match(challenge.message,/Turret NFT P2P alert access/);const signature=await wallet(account).signMessage({message:challenge.message});return (await request('/session',{id:challenge.id,signature})).session;}
  const read=(fn,args=[])=>client.readContract({address:manager.address,abi:manager.abi,functionName:fn,args});
  async function open(id){await send(lender,manager,'createOffer',[{borrower,collection:nft.address,tokenId:id,principal:10_000000n,interest:1_000000n,duration:86400n,expiresAt:BigInt(Math.floor(now/1000))+1800n}]);await send(borrower,manager,'acceptOffer',[id]);await mine();await service.tick();}
  await service.tick();const capabilities=await request('/capabilities');assert.equal(capabilities.protocol,'nft');assert.equal(capabilities.monitorReady,true);
  for(const account of [lender,borrower]){
    await request('/subscriptions',{channel:'email',email:`${account}@example.test`},await session(account));await service.tick();
    const confirmation=delivered.at(-1);assert.match(confirmation.text,/\/p2p\/nfts\?alerts=verify#/);
    await request('/verify',{token:confirmation.text.match(/#([a-f0-9]{64})/)[1]});
  }
  delivered.length=0;await open(1n);assert.equal(delivered.filter(x=>x.text.includes('Loan accepted')).length,2);
  assert.ok(delivered.every(x=>x.text.includes(`Collection: ${nft.address.toLowerCase()}`)&&x.text.includes('NFT token ID: 1')));
  const deadline=(await read('getOffer',[1n])).dueAt+86400n;
  await mine(deadline-80000n);await service.tick();assert.equal(delivered.filter(x=>x.text.includes('within one day')).length,2);
  rejectDelivery=true;await mine(deadline-3500n);await service.tick();assert.equal(service.store.all('outbox').filter(x=>x.kind==='p2p-deadline').length,2);
  service.stop();await new Promise(r=>service.server.close(r));service.store.close();
  service=createAlertsService(options);await new Promise(r=>service.server.listen(0,'127.0.0.1',r));
  rejectDelivery=false;await mine(deadline-3400n);await service.tick();assert.equal(delivered.filter(x=>x.text.includes('within one hour')).length,2);
  await send(owner,manager,'setCollectionAllowed',[nft.address,false]);await send(owner,manager,'setNewLoansPaused',[true]);
  await send(borrower,manager,'repay',[1n]);await mine();await service.tick();assert.equal(delivered.filter(x=>x.text.includes('Loan repaid')).length,2);
  const before=delivered.length;await mine(deadline+1n);await service.tick();assert.equal(delivered.length,before,'settlement removes reminders despite removed collection');
  await send(owner,manager,'setCollectionAllowed',[nft.address,true]);await send(owner,manager,'setNewLoansPaused',[false]);
  await open(2n);const deadline2=(await read('getOffer',[2n])).dueAt+86400n;
  await mine(deadline2+1n);await service.tick();assert.equal(delivered.filter(x=>x.text.includes('Final repayment deadline passed')).length,2);
  await send(lender,manager,'settleDefault',[2n]);await mine();await service.tick();assert.equal(delivered.filter(x=>x.text.includes('Default settled')).length,2);
  await request('/subscriptions',{channel:'email'},await session(lender),'DELETE');
  const start=delivered.length;await open(3n);assert.equal(delivered.length-start,1,'revoked lender receives no new loan alerts');
});
