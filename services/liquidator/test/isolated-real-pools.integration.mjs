import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createPublicClient,createWalletClient,http,parseAbi,encodeFunctionData,keccak256,toHex} from 'viem';
import {generatePrivateKey,privateKeyToAccount} from 'viem/accounts';
import {readOnlyForkProxy} from './read-only-fork-proxy.mjs';
import {isolatedConfigFromEnv} from '../src/isolated/config.mjs';
import {IsolatedChain} from '../src/isolated/chain.mjs';
import {IsolatedEngine} from '../src/isolated/engine.mjs';
import {IsolatedTransactions} from '../src/isolated/transactions.mjs';
import {Store} from '../src/store.mjs';

const USDG='0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168',WETH='0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73';
const USDG_POOL='0x52e65B17fB6E5BA00Ed806f37Afcd2DaA50271Ca',FACTORY='0x1f7d7550B1b028f7571E69A784071F0205FD2EfA';
const markets=[
  {symbol:'CASHCAT',token:'0x020bfC650A365f8BB26819deAAbF3E21291018b4',venue:'0xA70fc67C9F69da90B63a0e4C05D229954574E313',hash:'0x725781ccca82a0bf9b1f8920b2fe58ea1e4facf46d0db9f50226d6409de890fe'},
  {symbol:'PONS',token:'0x39dBED3a2bd333467115dE45665cC57F813C4571',venue:'0x10CC6BD38112cAc182db90B6a71d8Bb5939526bA',hash:'0x16c3d3ede897688ddff79262606f13bead398332e65001f192460fbac4e1fb85'},
];
const erc20=parseAbi(['function balanceOf(address) view returns (uint256)','function approve(address,uint256) returns (bool)',
  'function transfer(address,uint256) returns (bool)','function totalSupply() view returns (uint256)','function deposit() payable']);
const artifact=(file,name)=>JSON.parse(readFileSync(new URL(`../../../contracts/out/${file}/${name}.json`,import.meta.url)));
async function unusedPort(){const s=createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p;}

for(const market of markets) for(const shockBps of [5500n,2500n]) {
  test(`real-pool keeper ${market.symbol}, ${shockBps} bps target`,{timeout:240000},async()=>{
    const rpc=process.env.ISOLATED_FORK_RPC_URL,block=process.env.ISOLATED_FORK_BLOCK;
    assert.ok(rpc && /^[1-9][0-9]*$/.test(block??''),'Explicit RPC and pinned block required; never skip this test');
    const proxy=await readOnlyForkProxy(rpc),port=await unusedPort(),url=`http://127.0.0.1:${port}`;
    const child=spawn('anvil',['--host','127.0.0.1','--port',String(port),'--fork-url',proxy.url,'--fork-block-number',block,
      '--chain-id','4663','--accounts','0','--silent'],{stdio:['ignore','ignore','pipe'],env:{PATH:process.env.PATH,HOME:process.env.HOME}});
    let childError='';child.stderr.on('data',chunk=>{childError=(childError+chunk).slice(-1500);});
    let spawnError;child.on('error',e=>{spawnError=e;});
    const client=createPublicClient({transport:http(url,{timeout:30000,retryCount:0}),cacheTime:0,pollingInterval:50});
    const directory=mkdtempSync(join(tmpdir(),'dockyard-real-pool-keeper-'));let store;
    try {
      let ready=false;
      for(let i=0;i<100;i++) {
        if(spawnError || child.exitCode!==null)throw new Error('Local Anvil failed: '+(spawnError?.code??childError));
        try {if(await client.getChainId()===4663){ready=true;break;}}catch{}
        await new Promise(r=>setTimeout(r,100));
      }
      assert.ok(ready);assert.match(await client.request({method:'web3_clientVersion'}),/anvil/i);
      assert.equal(await client.getBlockNumber(),BigInt(block));
      assert.equal(keccak256(await client.getCode({address:market.token})),market.hash);
      // All mutation and signing targets the fresh loopback child. The upstream
      // proxy rejects broadcasts and state changes. No production key is loaded.
      const owner=privateKeyToAccount(generatePrivateKey()),borrower=privateKeyToAccount(generatePrivateKey());
      const keeperKey=generatePrivateKey(),keeper=privateKeyToAccount(keeperKey);
      for(const a of [owner,borrower,keeper])await client.request({method:'anvil_setBalance',params:[a.address,toHex(1000n*10n**18n)]});
      await client.request({method:'evm_setNextBlockTimestamp',params:[Math.floor(Date.now()/1000)]});
      await client.request({method:'evm_mine',params:[]});
      const wallet=a=>createWalletClient({account:a,transport:http(url)}),ownerWallet=wallet(owner),borrowerWallet=wallet(borrower);
      const abis=new Map([[USDG,erc20],[WETH,erc20],[market.token,erc20]]);
      const read=(address,functionName,args=[])=>client.readContract({address,abi:abis.get(address),functionName,args});
      async function write(address,functionName,args=[],w=ownerWallet,value){
        const request={address,abi:abis.get(address),functionName,args,chain:null,value};
        // Fixed, bounded fixture gas avoids unstable fork setup estimates.
        // Actual keeper transactions retain their real estimator and fee limits.
        const gas=5000000n;
        await client.simulateContract({...request,account:w.account,gas});
        const hash=await w.writeContract({...request,gas});
        const receipt=await client.waitForTransactionReceipt({hash});
        assert.equal(receipt.status,'success',`Fixture ${functionName} transaction must succeed`);
        return receipt;
      }
      async function deploy(file,name,args=[]){
        const a=artifact(file,name),hash=await ownerWallet.deployContract({abi:a.abi,bytecode:a.bytecode.object,args,chain:null});
        const receipt=await client.waitForTransactionReceipt({hash});assert.equal(receipt.status,'success');
        abis.set(receipt.contractAddress,a.abi);return receipt.contractAddress;
      }
      const helper=await deploy('DockyardForkSwapHarness.sol','DockyardForkSwapHarness');
      await write(WETH,'deposit',[],ownerWallet,600n*10n**18n);
      async function swap(input,venue,amount){
        await write(input,'approve',[helper,amount]);
        assert.ok(await read(input,'balanceOf',[owner.address])>=amount,'Setup swap funding must survive approval mining');
        await write(helper,'swap',[input,venue,amount]);
      }
      const price=async()=>{
        const weth=await read(helper,'spot',[market.venue,market.token,10n**18n]);
        return (await read(helper,'spot',[USDG_POOL,WETH,weth]))*10n**12n;
      };
      await swap(WETH,USDG_POOL,250n*10n**18n);
      const lenderCash=await read(USDG,'balanceOf',[owner.address]);
      await swap(WETH,market.venue,100n*10n**18n);
      const collateral=await read(market.token,'balanceOf',[owner.address]),initial=await price();
      const primary=await deploy('DockyardUSDGCreditVault.t.sol','DockyardMockOracle',[18,initial]);
      const secondary=await deploy('DockyardUSDGCreditVault.t.sol','DockyardMockOracle',[18,initial]);
      const engine=await deploy('DockyardIsolatedCreditEngine.sol','DockyardIsolatedCreditEngine',[{
        usdg:USDG,collateral:market.token,primary,secondary,guardian:owner.address,staleness:3600n,
        maxLtvBps:5000,liquidationLtvBps:6500,bonusBps:500,deviationBps:500,minimumDebt:1000000n,
      }]);
      const pool=await deploy('DockyardIsolatedCapitalPool.sol','DockyardIsolatedCapitalPool',[
        USDG,market.token,engine,owner.address,1000000000000n,1000,1000]);
      await write(engine,'bindPool',[pool]);await write(engine,'setRiskPaused',[false]);
      const supplied=lenderCash*8n/10n;
      await write(USDG,'approve',[pool,supplied]);await write(pool,'deposit',[supplied,owner.address]);
      await write(market.token,'transfer',[borrower.address,collateral]);
      await write(market.token,'approve',[engine,collateral],borrowerWallet);
      const loan=collateral*initial/10n**18n*4000n/10000n/10n**12n;
      await write(engine,'depositAndBorrow',[collateral,loan],borrowerWallet);
      assert.ok(loan>90000000000n && loan<110000000000n);
      const executor=await deploy('DockyardAtomicLiquidator.sol','DockyardAtomicLiquidator',[engine,WETH,market.venue,USDG_POOL,FACTORY]);
      const runtime=async address=>keccak256(await client.getCode({address}));
      const config=isolatedConfigFromEnv({KEEPER_RPC_URL:url,KEEPER_MODE:'execute',KEEPER_PRIVATE_KEY:keeperKey,KEEPER_CONFIRMATIONS:'1',
        ISOLATED_ENGINE_ADDRESS:engine,ISOLATED_POOL_ADDRESS:pool,ISOLATED_COLLATERAL_ADDRESS:market.token,
        ISOLATED_PRIMARY_ORACLE:primary,ISOLATED_SECONDARY_ORACLE:secondary,
        ISOLATED_ENGINE_CODE_HASH:await runtime(engine),ISOLATED_POOL_CODE_HASH:await runtime(pool),
        ISOLATED_COLLATERAL_CODE_HASH:market.hash,ISOLATED_PRIMARY_CODE_HASH:await runtime(primary),ISOLATED_SECONDARY_CODE_HASH:await runtime(secondary),
        ISOLATED_EXIT_ADDRESS:executor,ISOLATED_EXIT_CODE_HASH:await runtime(executor),
        KEEPER_MAX_REPAY_USDG:'110000',KEEPER_DAILY_BUDGET_USDG:'200000',KEEPER_INVENTORY_BUDGET_USDG:'200000',
        KEEPER_MAX_TX_FEE_ETH:'1',KEEPER_DAILY_GAS_ETH:'10'});
      const identity={protocol:'isolated-real-pool-test',engine,pool,account:keeper.address};
      const chain=new IsolatedChain(config);let worker;
      const restart=()=>{store?.close();store=new Store(directory,identity);store.acquireLease();worker=new IsolatedEngine(chain,store,config,new IsolatedTransactions(chain,store,config));};
      restart();assert.equal((await worker.cycle()).unhealthyPositions,0);
      // Obtain the balance mapping slot from this local token's actual SLOAD;
      // never guess a storage layout or mutate pool balances/code. Synthetic
      // whale inventory mirrors Foundry deal(token) in the economic fork suite.
      const data=encodeFunctionData({abi:erc20,functionName:'balanceOf',args:[owner.address]});
      const trace=await client.request({method:'debug_traceCall',params:[{to:market.token,data},'latest',{disableMemory:true,disableStorage:true}]});
      const loads=trace.structLogs.filter(x=>x.op==='SLOAD');assert.equal(loads.length,1,'Fixture requires a direct single-slot balance mapping');
      const slot='0x'+loads[0].stack.at(-1).replace(/^0x/,'').padStart(64,'0');
      const chunk=(await read(market.token,'balanceOf',[market.venue]))/20n;
      const supply=await read(market.token,'totalSupply');
      for(let i=0;i<60 && await price()>initial*shockBps/10000n;i++) {
        const balance=await read(market.token,'balanceOf',[owner.address]);
        const poolBalance=await read(market.token,'balanceOf',[market.venue]);
        await client.request({method:'anvil_setStorageAt',params:[market.token,slot,toHex(balance+chunk,{size:32})]});
        assert.equal(await read(market.token,'balanceOf',[owner.address]),balance+chunk);
        assert.equal(await read(market.token,'balanceOf',[market.venue]),poolBalance);
        assert.equal(await read(market.token,'totalSupply'),supply);
        await swap(market.token,market.venue,chunk);
      }
      assert.ok(await price()<=initial*shockBps/10000n);
      const refresh=async()=>{const value=await price();for(const feed of [primary,secondary])await write(feed,'setAnswer',[value]);};
      await refresh();await write(engine,'setRiskPaused',[true]);
      const unfunded=await worker.cycle();assert.equal(unfunded.unhealthyPositions,1);assert.equal(store.pendingTx(),undefined);
      assert.ok(unfunded.incidents.some(i=>i.code==='liquidation_unfunded'));
      await write(USDG,'transfer',[keeper.address,110000000000n]);
      let state;
      for(let i=0;i<12;i++) {
        await refresh();state=await worker.cycle();assert.equal(state.reconciled,true);
        if(!store.pendingTx()) {
          assert.equal(state.unhealthyPositions,0,'Liquidation remains blocked: '+JSON.stringify(state.incidents,(_,v)=>typeof v==='bigint'?v.toString():v));
          break;
        }
        await client.request({method:'anvil_mine',params:['0x2']});restart();
      }
      assert.equal(store.pendingTx(),undefined);assert.equal(state.unhealthyPositions,0);
      const liquidations=store.transactions().filter(t=>t.kind==='liquidation');
      assert.ok(liquidations.length>=1);assert.ok(liquidations.every(t=>t.status==='confirmed'&&t.inventoryRecovered));
      assert.ok(liquidations.some(t=>t.sizingAttempts>1),'Real price impact must exercise adaptive sizing');
      const repaid=liquidations.reduce((sum,t)=>sum+t.actualRepay,0n);
      const grossProfit=liquidations.reduce((sum,t)=>sum+t.usdgOut-t.actualRepay,0n);
      assert.equal(store.budgets().daily,repaid);assert.equal(store.budgets().inventory,0n);
      assert.equal(await read(USDG,'balanceOf',[keeper.address]),110000000000n+grossProfit);
      for(const token of [USDG,WETH,market.token])assert.equal(await read(token,'balanceOf',[executor]),0n);
      const remaining=await read(engine,'positionDebt',[borrower.address]);
      const loss=await read(pool,'cumulativeLoss');
      if(shockBps===2500n){assert.equal(remaining,0n);assert.ok(loss>0n);}else{assert.ok(remaining>0n);assert.equal(loss,0n);}
      // Recovery after an outage is a borrower action, not keeper repayment.
      for(const feed of [primary,secondary])await write(feed,'setShouldRevert',[true]);
      if(remaining){await write(USDG,'approve',[engine,remaining+1000000n],borrowerWallet);await write(engine,'close',[remaining+1000000n,borrower.address],borrowerWallet);}
      else {const [held]=await read(engine,'positions',[borrower.address]);if(held)await write(engine,'withdrawCollateral',[held,borrower.address],borrowerWallet);}
      assert.equal(await read(engine,'activeDebtPositions'),0n);assert.equal(await read(pool,'outstandingPrincipal'),0n);
      const shares=await read(pool,'balanceOf',[owner.address]),before=await read(USDG,'balanceOf',[owner.address]);
      await write(pool,'redeem',[shares,owner.address,owner.address]);
      const withdrawn=(await read(USDG,'balanceOf',[owner.address]))-before;
      assert.ok(withdrawn+loss>=supplied-1n && withdrawn+loss<supplied+1000000n);
      console.log(JSON.stringify({evidence:'real_pool_isolated_keeper',market:market.symbol,forkBlock:block,targetBps:Number(shockBps),
        mockOracles:true,syntheticWhaleInventory:true,loan:loan.toString(),liquidations:liquidations.length,
        sizingAttempts:liquidations.map(t=>t.sizingAttempts),repaid:repaid.toString(),grossProfitBeforeGas:grossProfit.toString(),
        remainingDebtBeforeVoluntaryClosure:remaining.toString(),recognizedLoss:loss.toString(),lenderWithdrawal:withdrawn.toString(),
        restartedBetweenTransactions:true,productionTransactions:0}));
    } finally {
      store?.close();
      if(child.exitCode===null && !spawnError){child.kill('SIGTERM');await new Promise(r=>child.once('exit',r));}
      await proxy.close();rmSync(directory,{recursive:true,force:true});
    }
  });
}
