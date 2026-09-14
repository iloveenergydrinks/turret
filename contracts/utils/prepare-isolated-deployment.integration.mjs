import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {readFileSync} from 'node:fs';
import {createPublicClient,createWalletClient,decodeEventLog,http,keccak256,toHex} from 'viem';
import {generatePrivateKey,privateKeyToAccount} from 'viem/accounts';
import {deploymentData,encodeConfiguration,preflightDeployment} from './prepare-isolated-deployment.mjs';
import {verifyDeployment} from './verify-isolated-deployment.mjs';
import {isolatedConfigFromEnv} from '../../services/liquidator/src/isolated/config.mjs';
import {isolatedAlertsDeployment} from '../../services/borrower-alerts/src/isolated-deployment.mjs';

const artifact=(file,name)=>JSON.parse(readFileSync(new URL(`../out/${file}/${name}.json`,import.meta.url),'utf8'));
const USDG='0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';
const PONS='0x39dBED3a2bd333467115dE45665cC57F813C4571';

test('compiled deployment preflight and signed local assembly preserve configuration and fund recovery',{timeout:90000},async()=>{
  const listener=createServer();
  await new Promise((resolve,reject)=>{listener.once('error',reject);listener.listen(0,'127.0.0.1',resolve);});
  const port=listener.address().port;await new Promise(resolve=>listener.close(resolve));
  const url=`http://127.0.0.1:${port}`;
  const child=spawn('anvil',['--host','127.0.0.1','--port',String(port),'--chain-id','4663','--accounts','0','--silent'],{stdio:'ignore'});
  let startupError;child.on('error',error=>{startupError=error;});
  const client=createPublicClient({transport:http(url,{timeout:5000,retryCount:0}),cacheTime:0,pollingInterval:30});
  try {
    let ready=false;
    for(let i=0;i<100;i++) {
      if(startupError||child.exitCode!==null)throw Error('Disposable Anvil failed');
      try {if(await client.getChainId()===4663){ready=true;break;}}catch{}
      await new Promise(resolve=>setTimeout(resolve,50));
    }
    assert.ok(ready);assert.match(await client.request({method:'web3_clientVersion'}),/anvil/i);
    // All writes are to the newly spawned loopback node, never a public RPC.
    const account=privateKeyToAccount(generatePrivateKey());
    await client.request({method:'anvil_setBalance',params:[account.address,toHex(100n*10n**18n)]});
    const wallet=createWalletClient({account,transport:http(url)}),abis=new Map();
    async function deploy(file,name,args=[]) {
      const a=artifact(file,name);
      const hash=await wallet.deployContract({abi:a.abi,bytecode:a.bytecode.object,args,chain:null});
      const r=await client.waitForTransactionReceipt({hash});assert.equal(r.status,'success');
      abis.set(r.contractAddress,a.abi);return r.contractAddress;
    }
    async function write(address,functionName,args=[]) {
      const request={address,abi:abis.get(address),functionName,args,chain:null,gas:5000000n};
      await client.simulateContract({...request,account});
      const hash=await wallet.writeContract(request);
      assert.equal((await client.waitForTransactionReceipt({hash})).status,'success');
    }
    const read=(address,functionName,args=[])=>client.readContract({address,abi:abis.get(address),functionName,args});
    for(const [canonical,decimals] of [[USDG,6],[PONS,18]]) {
      const mock=await deploy('DockyardUSDGCreditVault.t.sol','DockyardMockERC20',['Fixture','FIX',decimals]);
      await client.request({method:'anvil_setCode',params:[canonical,await client.getCode({address:mock})]});
      abis.set(canonical,abis.get(mock));
    }
    const primary=await deploy('DockyardUSDGCreditVault.t.sol','DockyardMockOracle',[8,10000000000n]);
    const secondary=await deploy('DockyardUSDGCreditVault.t.sol','DockyardMockOracle',[8,10000000000n]);
    const intermediate=await deploy('DockyardUSDGCreditVault.t.sol','DockyardMockERC20',['WETH','WETH',18]);
    const factory=await deploy('DockyardV3TwapFeed.t.sol','IsolatedMockV3Factory');
    const firstPool=await deploy('DockyardAtomicLiquidator.t.sol','IsolatedExitMockPool',[PONS,intermediate,factory,10n**16n]);
    const secondPool=await deploy('DockyardAtomicLiquidator.t.sol','IsolatedExitMockPool',[intermediate,USDG,factory,10000000000n]);
    await write(factory,'register',[PONS,intermediate,firstPool]);
    await write(factory,'register',[intermediate,USDG,secondPool]);
    const pins={};
    for(const [name,address] of Object.entries({usdg:USDG,collateral:PONS,primary,secondary,intermediate,firstPool,secondPool,factory}))pins[name]=keccak256(await client.getCode({address}));
    const block=await client.getBlock();
    const input={chainId:'4663',deadline:String(block.timestamp+300n),credit:{usdg:USDG,collateral:PONS,primary,secondary,
      guardian:account.address,staleness:'3600',maxLtvBps:'5000',liquidationLtvBps:'6500',bonusBps:'500',deviationBps:'500',minimumDebt:'1000000'},
      treasury:account.address,debtLimit:'10000000000',revenueFeeBps:'1000',borrowAprBps:'1000',intermediate,firstPool,secondPool,factory,pins};
    const compiled=artifact('DockyardIsolatedMarketDeployment.sol','DockyardIsolatedMarketDeployment');
    const nonceBefore=await client.getTransactionCount({address:account.address});
    const plan=await preflightDeployment({input,artifact:compiled,deployer:account.address,client});
    assert.equal(await client.getTransactionCount({address:account.address}),nonceBefore);
    assert.equal(await client.getBlockNumber({cacheTime:0}),block.number);
    assert.equal(await client.getCode({address:plan.predicted.receipt}),undefined);
    const payload=deploymentData(encodeConfiguration(input),compiled);
    assert.equal(payload.initcodeHash,plan.initcodeHash);
    const hash=await wallet.sendTransaction({data:payload.data,gas:plan.gasLimit,nonce:plan.nonce,chain:null});
    const receipt=await client.waitForTransactionReceipt({hash});assert.equal(receipt.status,'success');
    assert.equal(receipt.contractAddress.toLowerCase(),plan.predicted.receipt.toLowerCase());
    assert.ok(receipt.gasUsed<=plan.gasLimit);
    const childArtifacts=Object.fromEntries([
      ['engine','DockyardIsolatedCreditEngine'],['pool','DockyardIsolatedCapitalPool'],['executor','DockyardAtomicLiquidator']
    ].map(([name,contract])=>[name,artifact(contract+'.sol',contract)]));
    const verification={input,artifact:compiled,childArtifacts,deployer:account.address,txHash:hash,client};
    await assert.rejects(verifyDeployment(verification),/Insufficient confirmations/);
    await client.request({method:'evm_mine',params:[]});
    const manifest=await verifyDeployment(verification);
    assert.equal(manifest.oracleServicesVerified,false,'bare deployment evidence must not claim a configured oracle publisher');
    assert.equal(manifest.oracleServices,null);
    assert.equal(manifest.configHash,plan.configHash);
    assert.equal(manifest.frontendCandidate.engine,plan.predicted.engine);
    assert.equal(manifest.productionApproved,false);
    const keeperConfig=isolatedConfigFromEnv({...manifest.keeperCandidate,KEEPER_RPC_URL:url});
    assert.equal(keeperConfig.mode,'observe');
    assert.equal(keeperConfig.vault,plan.predicted.engine);
    assert.equal(isolatedAlertsDeployment(manifest.alertsCandidate).vault,plan.predicted.engine);
    // Reject altered evidence rather than exporting unverified runtime hashes.
    const rejectWith=async (overrides,pattern)=>assert.rejects(verifyDeployment({...verification,client:{...client,...overrides}}),pattern);
    await rejectWith({getTransaction:async args=>({...await client.getTransaction(args),input:'0x00'})},/initcode/);
    await rejectWith({getTransactionReceipt:async args=>({...await client.getTransactionReceipt(args),status:'reverted'})},/successfully mined/);
    await rejectWith({getTransactionReceipt:async args=>{
      const r=await client.getTransactionReceipt(args);
      return {...r,logs:[...r.logs,...r.logs.filter(l=>l.address.toLowerCase()===plan.predicted.receipt.toLowerCase())]};
    }},/Exactly one/);
    await rejectWith({getCode:async args=>args.address===plan.predicted.engine?'0x00':client.getCode(args)},/runtime lengths/);
    await rejectWith({getCode:async args=>args.address.toLowerCase()===primary.toLowerCase()?'0x00':client.getCode(args)},/Dependency changed/);
    await rejectWith({readContract:async args=>args.address===plan.predicted.engine&&args.functionName==='owner'?PONS:client.readContract(args)},/binding mismatch/);
    await rejectWith({readContract:async args=>args.address===plan.predicted.engine&&args.functionName==='riskPaused'?false:client.readContract(args)},/borrowing paused/);
    await rejectWith({readContract:async args=>args.functionName==='balanceOf'&&args.args[0]===plan.predicted.engine?1n:client.readContract(args)},/Unexpected funds/);
    await rejectWith({getTransaction:async args=>({...await client.getTransaction(args),chainId:1})},/transaction chain/);
    await rejectWith({getBlock:async args=>{
      const b=await client.getBlock(args);
      return args?.blockNumber===receipt.blockNumber?{...b,hash:'0x'+'11'.repeat(32)}:b;
    }},/not canonical/);
    abis.set(plan.predicted.receipt,compiled.abi);
    const event=receipt.logs.map(log=>{try{return decodeEventLog({abi:compiled.abi,data:log.data,topics:log.topics});}catch{return null;}}).find(e=>e?.eventName==='MarketDeployed');
    assert.equal(event.args.configHash,plan.configHash);
    for(const [name,contractName] of [['engine','DockyardIsolatedCreditEngine'],['pool','DockyardIsolatedCapitalPool'],['executor','DockyardAtomicLiquidator']]){
      assert.equal(await read(plan.predicted.receipt,name),plan.predicted[name]);
      assert.equal(event.args[name],plan.predicted[name]);
      abis.set(plan.predicted[name],artifact(contractName+'.sol',contractName).abi);
    }
    const {engine,pool}=plan.predicted;
    assert.equal(await read(engine,'owner'),account.address);
    assert.equal(await read(engine,'riskPaused'),true);
    assert.equal(await read(pool,'totalAssets'),0n);
    await write(USDG,'mint',[account.address,1000000000n]);
    await write(USDG,'approve',[pool,1000000000n]);
    await write(pool,'deposit',[1000000000n,account.address]);
    await write(PONS,'mint',[account.address,10n**19n]);
    await write(PONS,'approve',[engine,10n**19n]);
    await assert.rejects(client.simulateContract({account,address:engine,abi:abis.get(engine),functionName:'depositAndBorrow',args:[10n**19n,400000000n]}));
    await write(engine,'setRiskPaused',[false]);
    await write(engine,'depositAndBorrow',[10n**19n,400000000n]);
    await assert.rejects(verifyDeployment(verification),/borrowing paused/);
    await write(primary,'setShouldRevert',[true]);await write(secondary,'setShouldRevert',[true]);
    await write(USDG,'mint',[account.address,1000000n]);
    await write(USDG,'approve',[engine,401000000n]);
    await write(engine,'close',[401000000n,account.address]);
    assert.equal(await read(PONS,'balanceOf',[account.address]),10n**19n);
    await write(pool,'redeem',[await read(pool,'balanceOf',[account.address]),account.address,account.address]);
    assert.ok(await read(USDG,'balanceOf',[account.address])>=1000000000n);
    assert.equal(await read(engine,'activeDebtPositions'),0n);
    assert.equal(await read(pool,'outstandingPrincipal'),0n);
    assert.equal(plan.productionApproved,false);
  } finally {
    if(child.exitCode===null&&!startupError){child.kill('SIGTERM');await new Promise(resolve=>child.once('close',resolve));}
  }
});
