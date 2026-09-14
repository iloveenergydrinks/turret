import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPublicClient,createWalletClient,http,parseAbi,keccak256,toHex } from 'viem';
import { generatePrivateKey,privateKeyToAccount } from 'viem/accounts';
import { configFromEnv,PRODUCTION } from '../src/config.mjs';
import { Chain } from '../src/chain.mjs';
import { Store } from '../src/store.mjs';
import { Transactions } from '../src/transactions.mjs';
import { Engine } from '../src/engine.mjs';
import { vaultAbi,tokenAbi } from '../src/abi.mjs';

const testAbi=parseAbi([
  'function depositAndBorrow(address,uint256,uint256)',
  'function withdrawLiquidity(address,uint256)',
  'function setMarketEnabled(address,bool)',
  'function transfer(address,uint256) returns (bool)',
]);
// An oracle fault injector installed exclusively on the local Anvil fork.
function feedCode(price,timestamp){
  return '0x'+[1n,price,timestamp,timestamp,1n].map((word,i)=>'7f'+word.toString(16).padStart(64,'0')+'60'+(i*32).toString(16).padStart(2,'0')+'52').join('')+'60a06000f3';
}

test('deployed vault: discover, reject stale feeds, handle no funds, approve, restart and liquidate', {timeout:240000}, async()=>{
  const rpc=process.env.FORK_RPC_URL;
  assert.ok(rpc,'FORK_RPC_URL required; this test must run against an Anvil fork');
  const remote=createPublicClient({transport:http(rpc,{timeout:15000,retryCount:0})});
  assert.equal(await remote.getChainId(),4663);
  const forkBlock=process.env.FORK_BLOCK ? BigInt(process.env.FORK_BLOCK) : await remote.getBlockNumber();
  const port=18545;
  const url=`http://127.0.0.1:${port}`;
  const child=spawn('anvil',['--host','127.0.0.1','--port',String(port),'--fork-url',rpc,'--fork-block-number',String(forkBlock),'--chain-id','4663','--accounts','0','--silent'],{stdio:'ignore'});
  const client=createPublicClient({transport:http(url,{timeout:20000,retryCount:0}),cacheTime:0});
  const directory=mkdtempSync(join(tmpdir(),'dockyard-fork-'));
  let store;
  try {
    let started=false;
    for(let i=0;i<100;i++) {
      try {if(await client.getChainId()===4663){started=true;break;}}catch{}
      if(child.exitCode!==null) throw new Error('Anvil failed to start');
      await new Promise(resolve=>setTimeout(resolve,100));
    }
    assert.ok(started,'Anvil startup');
    // Destructive test RPCs are allowed only on this loopback Anvil child.
    assert.match(await client.request({method:'web3_clientVersion'}),/anvil/i);
    const owner=await client.readContract({address:PRODUCTION.vault,abi:vaultAbi,functionName:'owner'});
    const collateral=await client.readContract({address:PRODUCTION.vault,abi:vaultAbi,functionName:'collateralAt',args:[0n]});
    const market=await client.readContract({address:PRODUCTION.vault,abi:vaultAbi,functionName:'markets',args:[collateral]});
    assert.equal(await client.readContract({address:PRODUCTION.vault,abi:vaultAbi,functionName:'totalDebt'}),0n,'Fork scenario expects an initially debt-free vault');
    const collateralBefore=await client.readContract({address:collateral,abi:tokenAbi,functionName:'balanceOf',args:[owner]});
    assert.ok(collateralBefore>=5000000000000000n,'Owner must hold the purchased AAPL canary collateral at this fork block');
    await client.request({method:'anvil_impersonateAccount',params:[owner]});
    await client.request({method:'anvil_setBalance',params:[owner,toHex(10n**18n)]});
    const wallet=createWalletClient({account:owner,transport:http(url)});
    const write=async(address,abi,functionName,args)=>{
      const hash=await wallet.writeContract({address,abi,functionName,args,chain:null});
      const receipt=await client.waitForTransactionReceipt({hash});assert.equal(receipt.status,'success');return receipt;
    };
    await write(collateral,tokenAbi,'approve',[PRODUCTION.vault,5000000000000000n]);
    await write(PRODUCTION.vault,testAbi,'depositAndBorrow',[collateral,5000000000000000n,500000n]);
    const privateKey=generatePrivateKey(),account=privateKeyToAccount(privateKey);
    await client.request({method:'anvil_setBalance',params:[account.address,toHex(10n**18n)]});
    const code=await client.getCode({address:PRODUCTION.vault});
    const config={...configFromEnv({KEEPER_RPC_URL:url,KEEPER_MODE:'execute',KEEPER_PRIVATE_KEY:privateKey,KEEPER_VAULT_CODE_HASH:keccak256(code)}),startBlock:forkBlock,confirmations:2n,maxHeadAgeSeconds:864000};
    const identity={chainId:4663,vault:PRODUCTION.vault,account:account.address};
    const chain=new Chain(config);
    store=new Store(directory,identity);store.acquireLease();
    let engine=new Engine(chain,store,config,new Transactions(chain,store,config));
    const initial=await engine.cycle();assert.equal(initial.openPositions,1);assert.equal(initial.unhealthyPositions,0);assert.equal(initial.reconciled,true);
    const head=await client.getBlock();
    for(const feed of [market[0],market[1]]) await client.request({method:'anvil_setCode',params:[feed,feedCode(15000000000n,head.timestamp-86400n)]});
    await client.request({method:'evm_mine',params:[]});
    const stale=await engine.cycle();assert.ok(stale.incidents.some(x=>x.code.startsWith('oracle_blocked:')));assert.equal(store.pendingTx(),undefined);
    await client.request({method:'anvil_setCode',params:[market[0],'0x60006000fd']});
    await client.request({method:'anvil_setCode',params:[market[1],feedCode(15000000000n,head.timestamp)]});
    await write(PRODUCTION.vault,testAbi,'setMarketEnabled',[collateral,false]);
    const unfunded=await engine.cycle();assert.equal(unfunded.unhealthyPositions,1);assert.equal(store.pendingTx(),undefined);
    assert.ok(unfunded.incidents.some(x=>x.code==='liquidation_unfunded'));
    assert.ok(unfunded.incidents.some(x=>x.code.startsWith('oracle_degraded:')));
    await write(PRODUCTION.vault,testAbi,'withdrawLiquidity',[account.address,10000000n]);
    await engine.cycle();assert.equal(store.pendingTx().kind,'approval');
    await client.request({method:'anvil_mine',params:['0x3']});
    store.close();store=new Store(directory,identity);store.acquireLease();
    engine=new Engine(chain,store,config,new Transactions(chain,store,config));
    await engine.cycle();assert.equal(store.pendingTx().kind,'liquidation');
    const hash=store.pendingTx().attempts.at(-1).hash;
    await client.request({method:'anvil_mine',params:['0x3']});
    const final=await engine.cycle();
    assert.equal(final.unhealthyPositions,0);assert.equal(final.totalDebt,0n);assert.equal(final.reconciled,true);
    assert.equal(store.pendingTx(),undefined);
    assert.equal(store.transactions().filter(x=>x.kind==='liquidation'&&x.status==='confirmed').length,1);
    assert.equal(store.budgets().inventory,502500n);
    assert.equal(await chain.token(collateral,'balanceOf',[account.address]),3517500000000000n);
    console.log(JSON.stringify({evidence:'fork_worker_liquidation',forkBlock:forkBlock.toString(),hash,repaid:'502500',seized:'3517500000000000',restartRecovered:true,disabledMarketCovered:true}));
  } finally {
    store?.close();child.kill('SIGTERM');
    await new Promise(resolve=>{if(child.exitCode!==null)resolve();else child.once('exit',resolve);});
    rmSync(directory,{recursive:true,force:true});
  }
});
