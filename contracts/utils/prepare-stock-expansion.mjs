import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {readFile,writeFile,chmod} from 'node:fs/promises';
import {createPublicClient,encodeDeployData,encodeFunctionData,getAddress,getContractAddress,http,keccak256,parseAbi,toHex} from 'viem';
import {generatePrivateKey,privateKeyToAccount} from 'viem/accounts';
import {encodeStockConfiguration,stockDeploymentData,stockDependencies} from './prepare-stock-deployment.mjs';

const RPC=process.env.COLLATERAL_RPC_URL??'https://rpc.mainnet.chain.robinhood.com';
const OWNER=getAddress('0x8D9c41c35a1Cf9A6958d58880d3DC5dca36f5086');
const USDG=getAddress('0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168');
const USDG_PRIMARY=getAddress('0x61B7e5650328764B076A108EFF5fa7282a1B9aD2');
const USDG_SECONDARY=getAddress('0x76850ffD6652FCb5DfD7ECBD359323d82395fF8d');
const EXIT_FACTORY=getAddress('0x1f7d7550B1b028f7571E69A784071F0205FD2EfA');
const MARKET_URL='https://turret.capital/borrow';
const SECRETS_FILE='/tmp/dockyard-stock-expansion-secrets.json';
const symbols=['MSFT','GOOGL','AMZN','META','NVDA','AMD','MU','TSLA'];
const salePools={
  MSFT:'0xeb60bCD1D920ad6E102690CCFC6fB488899E1510',
  GOOGL:'0x34D0dC122CF9A8Eb296fC5e0D3A233625D7d19b7',
  AMZN:'0x8AC92DA74AB5F3b1d024Dc1943Ad7e15Dc4179Ef',
  META:'0x107a7Cb40d8665360ba10E59471Af06150A50922',
  NVDA:'0xd4EB21209C4D6093f80B5b84f5C45cc093EA14a3',
  AMD:'0x48D284A2A4d3DC1b3Da08231Fe44317e7e7Aa51f',
  MU:'0xd057B1Bc54917855BBee58eAd58647f47caB35E5',
  TSLA:'0xf4ACdAEEB7022862A763C9B1B885e11191c889E3',
};

const readArtifact=async name=>(await import(`../out/${name}.sol/${name}.json`,{with:{type:'json'}})).default;
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const same=(a,b)=>a.toLowerCase()===b.toLowerCase();
const receiptAbi=parseAbi(['function totalCreated() view returns(uint256)','function operator() view returns(address)',
  'function deployBatch(bytes[] creationCode,bytes32[] initcodeHashes,bytes32[] runtimeHashes,uint256 expectedStart) returns(address[] deployed)']);

async function startAnvil(port,blockNumber) {
  const child=spawn('anvil',['--fork-url',RPC,'--fork-block-number',String(blockNumber),'--chain-id','4663','--port',String(port),
    '--host','127.0.0.1','--silent','--gas-limit','30000000'],{stdio:['ignore','ignore','pipe']});
  let stderr=''; child.stderr.on('data',chunk=>stderr+=chunk);
  const url=`http://127.0.0.1:${port}`;
  for(let i=0;i<80;i++) {
    try { const r=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'eth_chainId',params:[]})});
      if((await r.json()).result==='0x1237')return {child,url}; } catch {}
    if(child.exitCode!==null)throw Error(`Anvil stopped: ${stderr.slice(-500)}`);
    await wait(100);
  }
  child.kill('SIGTERM'); throw Error('Anvil did not start');
}

async function rpc(url,method,params=[]) {
  const response=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});
  const body=await response.json(); if(body.error)throw Error(`${method}: ${body.error.message}`); return body.result;
}

async function sendUnlocked(client,url,tx) {
  const hash=await rpc(url,'eth_sendTransaction',[{...tx,gas:toHex(29_000_000n)}]);
  const receipt=await client.waitForTransactionReceipt({hash,timeout:120000});
  assert.equal(receipt.status,'success'); return receipt;
}

async function main(){
  const [factoryArtifact,guardArtifact,gateArtifact,marketArtifact,exitArtifact,catalog]=await Promise.all([
    readArtifact('DockyardSequentialCreateFactory'),readArtifact('DockyardHeartbeatGuard'),readArtifact('DockyardExecutionGate'),readArtifact('DockyardStockMarketDeployment'),
    readArtifact('DockyardStockDirectLiquidator'),import('./assets/dockyard-pilot-heartbeat-config.json',{with:{type:'json'}}).then(m=>m.default)]);
  let secretRows;
  try { secretRows=JSON.parse(await readFile(SECRETS_FILE,'utf8')); }
  catch {
    secretRows=Object.fromEntries(symbols.map(symbol=>[symbol,{guardian:generatePrivateKey(),keeper:generatePrivateKey()}]));
    await writeFile(SECRETS_FILE,JSON.stringify(secretRows),{mode:0o600});await chmod(SECRETS_FILE,0o600);
  }
  const roles=Object.fromEntries(symbols.map(symbol=>{
    const row=secretRows[symbol];assert.match(row.guardian,/^0x[0-9a-f]{64}$/);assert.match(row.keeper,/^0x[0-9a-f]{64}$/);
    return [symbol,{guardian:privateKeyToAccount(row.guardian).address,keeper:privateKeyToAccount(row.keeper).address}];
  }));
  assert.equal(new Set(Object.values(roles).flatMap(Object.values).map(a=>a.toLowerCase())).size,symbols.length*2);
  const live=createPublicClient({transport:http(RPC,{timeout:30000,retryCount:1}),cacheTime:0});
  assert.equal(await live.getChainId(),4663);
  const head=await live.getBlock();
  assert.ok(BigInt(Math.floor(Date.now()/1000))-head.timestamp<60n,'Live head is stale');
  const ownerNonce=await live.getTransactionCount({address:OWNER});
  assert.equal(await live.getTransactionCount({address:OWNER,blockTag:'pending'}),ownerNonce,'Owner has a pending transaction');
  assert.ok(await live.getBalance({address:OWNER})>60_000_000_000_000_000n,'Owner gas reserve is below 0.06 ETH');
  const factoryAddress=getContractAddress({from:OWNER,nonce:BigInt(ownerNonce)});
  assert.ok(!(await live.getCode({address:factoryAddress})),'Predicted factory address is occupied');
  const factoryData=encodeDeployData({abi:factoryArtifact.abi,bytecode:factoryArtifact.bytecode.object,args:[OWNER]});
  const factoryRuntime=(await live.call({account:OWNER,data:factoryData,blockNumber:head.number})).data;
  assert.ok(factoryRuntime&&factoryRuntime!=='0x');

  const port=31467;
  const local=await startAnvil(port,head.number);
  try {
    const client=createPublicClient({transport:http(local.url,{timeout:30000,retryCount:0}),cacheTime:0,pollingInterval:100});
    await rpc(local.url,'anvil_impersonateAccount',[OWNER]);
    await rpc(local.url,'anvil_setBalance',[OWNER,toHex(100n*10n**18n)]);
    const factoryReceipt=await sendUnlocked(client,local.url,{from:OWNER,data:factoryData,nonce:toHex(ownerNonce)});
    assert.ok(same(factoryReceipt.contractAddress,factoryAddress));
    assert.equal(keccak256(await client.getCode({address:factoryAddress})),keccak256(factoryRuntime));
    const snapshot=await rpc(local.url,'evm_snapshot');
    await rpc(local.url,'anvil_impersonateAccount',[factoryAddress]);
    await rpc(local.url,'anvil_setBalance',[factoryAddress,toHex(100n*10n**18n)]);

    const shared={usdg:USDG,usdgPrimary:USDG_PRIMARY,usdgSecondary:USDG_SECONDARY};
    const sharedHashes=Object.fromEntries(await Promise.all(Object.entries(shared).map(async([key,address])=>{
      const code=await client.getCode({address}); assert.notEqual(code,'0x'); return [key,keccak256(code)];
    })));
    const factoryHash=keccak256(await client.getCode({address:EXIT_FACTORY}));
    assert.notEqual(factoryHash,keccak256('0x'));
    const deadline=head.timestamp+3600n;
    const plans=[];
    for(const [index,symbol] of symbols.entries()) {
      const identity=catalog.markets.find(m=>m.symbol===symbol); assert.ok(identity);
      const start=BigInt(index*4),nonce=1n+start;
      const guard=getContractAddress({from:factoryAddress,nonce});
      const gate=getContractAddress({from:factoryAddress,nonce:nonce+1n});
      const bundle=getContractAddress({from:factoryAddress,nonce:nonce+2n});
      const engine=getContractAddress({from:bundle,nonce:1n});
      const pool=getContractAddress({from:bundle,nonce:2n});
      const exit=getContractAddress({from:factoryAddress,nonce:nonce+3n});
      const addresses={guard,gate,bundle,engine,pool,exit};
      const expectedNonce=await client.getTransactionCount({address:factoryAddress}); assert.equal(BigInt(expectedNonce),nonce);

      const guardCode=encodeDeployData({abi:guardArtifact.abi,bytecode:guardArtifact.bytecode.object,
        args:[getAddress(identity.collateral),getAddress(identity.primaryOracle),roles[symbol].guardian,86400n]});
      let receipt=await sendUnlocked(client,local.url,{from:factoryAddress,data:guardCode,nonce:toHex(nonce)});
      assert.ok(same(receipt.contractAddress,guard));
      const guardRuntime=await client.getCode({address:guard});
      const gateCode=encodeDeployData({abi:gateArtifact.abi,bytecode:gateArtifact.bytecode.object,args:[roles[symbol].guardian]});
      receipt=await sendUnlocked(client,local.url,{from:factoryAddress,data:gateCode,nonce:toHex(nonce+1n)});
      assert.ok(same(receipt.contractAddress,gate));
      const gateRuntime=await client.getCode({address:gate});
      const collateralCode=await client.getCode({address:getAddress(identity.collateral)});
      const feedCode=await client.getCode({address:getAddress(identity.primaryOracle)});
      assert.notEqual(collateralCode,'0x'); assert.notEqual(feedCode,'0x');
      const input={chainId:'4663',deadline:String(deadline),credit:{usdg:USDG,collateral:getAddress(identity.collateral),
        primary:getAddress(identity.primaryOracle),secondary:guard,guardian:OWNER,staleness:'86400',maxLtvBps:'3000',
        liquidationLtvBps:'4000',bonusBps:'500',deviationBps:'200',minimumDebt:'1000000'},executionGate:gate,
        usdgPricing:{primary:USDG_PRIMARY,secondary:USDG_SECONDARY,primaryMaxAge:'90000',secondaryMaxAge:'90000',
          maxDeviationBps:'200',maxTimestampSkew:'90000'},treasury:OWNER,debtLimit:'10000000',revenueFeeBps:'1000',borrowAprBps:'1000',
        pins:{usdg:sharedHashes.usdg,collateral:keccak256(collateralCode),stockFeed:keccak256(feedCode),stockGuard:keccak256(guardRuntime),
          executionGate:keccak256(gateRuntime),usdgPrimary:sharedHashes.usdgPrimary,usdgSecondary:sharedHashes.usdgSecondary}};
      const prepared=encodeStockConfiguration(input);
      const marketCode=stockDeploymentData(prepared,marketArtifact).data;
      receipt=await sendUnlocked(client,local.url,{from:factoryAddress,data:marketCode,nonce:toHex(nonce+2n)});
      assert.ok(same(receipt.contractAddress,bundle));
      assert.notEqual(await client.getCode({address:engine}),'0x'); assert.notEqual(await client.getCode({address:pool}),'0x');
      const marketRuntime=await client.getCode({address:bundle});
      const exitCode=encodeDeployData({abi:exitArtifact.abi,bytecode:exitArtifact.bytecode.object,
        args:[engine,getAddress(salePools[symbol]),EXIT_FACTORY]});
      receipt=await sendUnlocked(client,local.url,{from:factoryAddress,data:exitCode,nonce:toHex(nonce+3n)});
      assert.ok(same(receipt.contractAddress,exit));
      const exitRuntime=await client.getCode({address:exit});
      plans.push({symbol,start:Number(start),roles:roles[symbol],addresses,input,configHash:prepared.configHash,
        creationCode:[guardCode,gateCode,marketCode,exitCode],initcodeHashes:[keccak256(guardCode),keccak256(gateCode),keccak256(marketCode),keccak256(exitCode)],
        runtimeHashes:[keccak256(guardRuntime),keccak256(gateRuntime),keccak256(marketRuntime),keccak256(exitRuntime)],salePool:getAddress(salePools[symbol])});
    }

    assert.equal(await rpc(local.url,'evm_revert',[snapshot]),true);
    assert.equal(await client.readContract({address:factoryAddress,abi:receiptAbi,functionName:'totalCreated'}),0n);
    await rpc(local.url,'anvil_impersonateAccount',[OWNER]);
    for(const plan of plans) {
      const data=encodeFunctionData({abi:receiptAbi,functionName:'deployBatch',args:[plan.creationCode,plan.initcodeHashes,plan.runtimeHashes,BigInt(plan.start)]});
      const gas=await client.estimateGas({account:OWNER,to:factoryAddress,data});
      assert.ok(gas<29_000_000n);
      const receipt=await sendUnlocked(client,local.url,{from:OWNER,to:factoryAddress,data});
      for(const [i,address] of [plan.addresses.guard,plan.addresses.gate,plan.addresses.bundle,plan.addresses.exit].entries()) {
        assert.equal(keccak256(await client.getCode({address})),plan.runtimeHashes[i]);
      }
      plan.transaction={to:factoryAddress,data,gas:toHex((gas*125n+99n)/100n),value:'0x0'};
      plan.simulatedGas=String(gas); plan.simulationReceipt=receipt.transactionHash;
      delete plan.creationCode;
    }
    assert.equal(await client.readContract({address:factoryAddress,abi:receiptAbi,functionName:'totalCreated'}),32n);
    const factoryGas=await live.estimateGas({account:OWNER,data:factoryData,blockNumber:head.number});
    const plan={version:1,chainId:4663,preparedAt:new Date().toISOString(),expiresAt:new Date(Number(deadline)*1000).toISOString(),
      snapshot:{blockNumber:String(head.number),blockHash:head.hash},owner:OWNER,ownerNonce,factory:{address:factoryAddress,
        initcodeHash:keccak256(factoryData),runtimeHash:keccak256(factoryRuntime),transaction:{data:factoryData,gas:toHex((factoryGas*125n+99n)/100n),value:'0x0'}},
      markets:plans,shared:{...shared,exitFactory:EXIT_FACTORY,exitFactoryCodeHash:factoryHash},marketUrl:MARKET_URL,
      constraints:{startsPaused:true,debtLimitUsdg:'10',liquidityUsdg:'20',orclExcluded:true,localFullSequenceSimulationPassed:true}};
    await writeFile('/tmp/dockyard-stock-expansion-plan.json',JSON.stringify(plan,null,2),{mode:0o600});
    const evidence={...plan,factory:{...plan.factory,transaction:undefined},markets:plan.markets.map(({transaction,...p})=>p)};
    await writeFile('../docs/security/evidence/2026-09-03/market-expansion-deployment-plan.json',JSON.stringify(evidence,null,2));
    console.log(JSON.stringify({prepared:true,factory:factoryAddress,markets:plans.map(p=>({symbol:p.symbol,...p.addresses,gas:p.simulatedGas})),expiresAt:plan.expiresAt}));
  } finally { local.child.kill('SIGTERM'); }
}

main().catch(error=>{console.error(error.stack);process.exitCode=1;});
