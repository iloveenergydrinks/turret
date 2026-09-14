import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { createServer as createHttpServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import { createPublicClient, createWalletClient, decodeFunctionData, encodeAbiParameters, erc20Abi, http, keccak256, parseAbiParameters, toHex, type Abi, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { ISOLATED_USDG, isolatedPoolAbi, prepareIsolatedAction, quoteLenderIntent, readIsolatedMarket,
  type IsolatedDeployment, type IsolatedIntent, type StockProofs } from "../src/isolated-credit";
import { fetchStockProofs } from "../src/isolated-stock-proofs";

const artifact = (file: string, name: string): {abi: Abi; bytecode: {object: Hex}} =>
  JSON.parse(readFileSync(new URL(`../../../contracts/out/${file}/${name}.json`,import.meta.url),"utf8"));

for (const stockMarket of [false,true]) test(`wallet transaction layer: ${stockMarket ? "guarded stock" : "generic isolated"} lender/borrower lifecycle`, {timeout:120000}, async () => {
  const reservation = createServer();
  await new Promise<void>(resolve => reservation.listen(0,"127.0.0.1",resolve));
  const bound = reservation.address();assert.ok(bound && typeof bound === "object");
  const port = bound.port;await new Promise<void>(resolve => reservation.close(() => resolve()));
  const child = spawn("anvil",["--host","127.0.0.1","--port",String(port),"--chain-id","4663","--accounts","0","--silent"],{stdio:"ignore"});
  let spawnError: unknown;child.on("error",e => {spawnError=e;});
  const transport = http(`http://127.0.0.1:${port}`,{timeout:5000,retryCount:0});
  const client = createPublicClient({transport,cacheTime:0,pollingInterval:25});
  let proofServer: Server | undefined;
  try {
    let started=false;
    for(let i=0;i<100;i++) {
      if(spawnError || child.exitCode!==null)throw new Error("Local Anvil unavailable");
      try {if(await client.getChainId()===4663){started=true;break;}}catch{}
      await new Promise(resolve => setTimeout(resolve,50));
    }
    assert.ok(started);assert.match(await client.request({method:"web3_clientVersion"}),/anvil/i);
    // Ephemeral local wallets only. This process never reads external RPCs or user keys.
    const lender = privateKeyToAccount(generatePrivateKey()),borrower = privateKeyToAccount(generatePrivateKey());
    for(const account of [lender,borrower])await client.request({method:"anvil_setBalance",params:[account.address,toHex(10n**19n)]} as never);
    const lenderWallet = createWalletClient({account:lender,transport});
    const borrowerWallet = createWalletClient({account:borrower,transport});
    const deployed = new Map<Address,Abi>();
    const deploy = async (a: ReturnType<typeof artifact>,args: readonly unknown[]) => {
      const hash = await lenderWallet.deployContract({abi:a.abi,bytecode:a.bytecode.object,args,chain:null});
      const receipt = await client.waitForTransactionReceipt({hash});assert.equal(receipt.status,"success");assert.ok(receipt.contractAddress);
      deployed.set(receipt.contractAddress,a.abi);return receipt.contractAddress;
    };
    const write = async (address: Address,functionName: string,args: readonly unknown[]) => {
      const hash = await lenderWallet.writeContract({address,abi:deployed.get(address)!,functionName,args,chain:null});
      assert.equal((await client.waitForTransactionReceipt({hash})).status,"success");
    };
    const read = (address:Address,functionName:string,args:readonly unknown[] = []) =>
      client.readContract({address,abi:deployed.get(address)!,functionName,args});
    const token = artifact("DockyardUSDGCreditVault.t.sol","DockyardMockERC20");
    const cash = await deploy(token,["Mock USDG","USDG",6]);
    await client.request({method:"anvil_setCode",params:[ISOLATED_USDG,await client.getCode({address:cash})]} as never);
    deployed.set(ISOLATED_USDG,token.abi);
    const collateral = stockMarket ? await deploy(artifact("DockyardOracleV2.t.sol","ScaledStockFixture"),[])
      : await deploy(token,["Mock collateral","COLL",18]);
    const oracle = artifact("DockyardUSDGCreditVault.t.sol","DockyardMockOracle");
    const primary = await deploy(oracle,[8,10000000000n]);
    const secondary = stockMarket ? await deploy(artifact("DockyardHeartbeatGuard.sol","DockyardHeartbeatGuard"),[collateral,primary,lender.address,86400])
      : await deploy(oracle,[8,10000000000n]);
    const stockDependencies = stockMarket ? {
      executionGate:await deploy(artifact("DockyardExecutionGate.sol","DockyardExecutionGate"),[lender.address]),
      usdgPrimary:await deploy(oracle,[8,100000000n]), usdgSecondary:await deploy(oracle,[18,10n**18n]),
    } : undefined;
    const config = {
      usdg:ISOLATED_USDG,collateral,primary,secondary,guardian:lender.address,staleness:86400n,maxLtvBps:5000,
      liquidationLtvBps:6500,bonusBps:500,deviationBps:stockMarket?200:500,minimumDebt:1000000n,
    };
    const engine = stockDependencies ? await deploy(artifact("DockyardStockCreditEngine.sol","DockyardStockCreditEngine"),[
      config,stockDependencies.executionGate,{primary:stockDependencies.usdgPrimary,secondary:stockDependencies.usdgSecondary,primaryMaxAge:300,secondaryMaxAge:300,maxDeviationBps:200,maxTimestampSkew:60},
    ]) : await deploy(artifact("DockyardIsolatedCreditEngine.sol","DockyardIsolatedCreditEngine"),[config]);
    const poolName = stockMarket ? "DockyardStockCapitalPool" : "DockyardIsolatedCapitalPool";
    const pool = await deploy(artifact(`${poolName}.sol`,poolName),[
      ISOLATED_USDG,collateral,engine,lender.address,1000000000n,1000,1000,
    ]);
    const healthySince = (await client.getBlock()).timestamp;
    const freshProofs = async ():Promise<StockProofs> => {
      assert.ok(stockDependencies);
      const timestamp = (await client.getBlock()).timestamp;
      const [value,updated,round] = await read(secondary,"currentData") as readonly bigint[];
      const h = {roundId:round!,observedAt:timestamp,validUntil:timestamp+45n,sessionOpen:timestamp-120n,sessionClose:timestamp+3600n,
        roundHash:keccak256(encodeAbiParameters(parseAbiParameters("uint80,uint256,uint256"),[round!,value!,updated!])),
        epoch:await read(secondary,"epoch") as bigint};
      const l = {observedAt:timestamp,healthySince,validUntil:timestamp+45n,epoch:await read(stockDependencies.executionGate,"epoch") as bigint};
      const healthSig = await lender.signTypedData({domain:{name:"DockyardChainlinkGuard",version:"1",chainId:4663,verifyingContract:secondary},
        types:{Health:[{name:"roundId",type:"uint80"},{name:"observedAt",type:"uint64"},{name:"validUntil",type:"uint64"},
          {name:"sessionOpen",type:"uint64"},{name:"sessionClose",type:"uint64"},{name:"roundHash",type:"bytes32"},{name:"epoch",type:"uint64"}]},primaryType:"Health",message:h});
      const marketSig = await lender.signTypedData({domain:{name:"DockyardStockCredit",version:"1",chainId:4663,verifyingContract:engine},
        types:{MarketHealth:[{name:"roundId",type:"uint80"},{name:"observedAt",type:"uint64"},{name:"validUntil",type:"uint64"},
          {name:"sessionOpen",type:"uint64"},{name:"sessionClose",type:"uint64"},{name:"roundHash",type:"bytes32"},{name:"epoch",type:"uint64"}]},primaryType:"MarketHealth",message:h});
      const liveSig = await lender.signTypedData({domain:{name:"DockyardExecutionGate",version:"1",chainId:4663,verifyingContract:stockDependencies.executionGate},
        types:{Liveness:[{name:"observedAt",type:"uint64"},{name:"healthySince",type:"uint64"},{name:"validUntil",type:"uint64"},{name:"epoch",type:"uint64"}]},primaryType:"Liveness",message:l});
      return {
        health:encodeAbiParameters(parseAbiParameters("(uint80 roundId,uint64 observedAt,uint64 validUntil,uint64 sessionOpen,uint64 sessionClose,bytes32 roundHash,uint64 epoch),bytes,bytes"),[h,healthSig,marketSig]),
        liveness:encodeAbiParameters(parseAbiParameters("(uint64 observedAt,uint64 healthySince,uint64 validUntil,uint64 epoch),bytes"),[l,liveSig]),
      };
    };
    await write(engine,"bindPool",[pool]);
    if(stockDependencies){
      await client.request({method:"evm_increaseTime",params:[120]} as never);
      await client.request({method:"evm_mine",params:[]} as never);
      await write(stockDependencies.executionGate,"submitLiveness",[(await freshProofs()).liveness]);
    }
    await write(engine,"setRiskPaused",[false]);
    await write(ISOLATED_USDG,"mint",[lender.address,1000000000n]);
    await write(collateral,"mint",[borrower.address,3n*10n**18n]);
    const codeHash = async (address: Address) => keccak256((await client.getCode({address}))!);
    const d: IsolatedDeployment = {chainId:4663,engine,pool,collateral,primary,secondary,hashes:{
      engine:await codeHash(engine),pool:await codeHash(pool),collateral:await codeHash(collateral),
      primary:await codeHash(primary),secondary:await codeHash(secondary),usdg:await codeHash(ISOLATED_USDG),
    }};
    if(stockDependencies)d.stock={...stockDependencies,hashes:{executionGate:await codeHash(stockDependencies.executionGate),
      usdgPrimary:await codeHash(stockDependencies.usdgPrimary),usdgSecondary:await codeHash(stockDependencies.usdgSecondary)}};
    let serviceAvailable=true;
    if(stockDependencies){
      // Real HTTP transport and real guardian signatures, but fixture market data.
      // This is not the production risk worker and cannot qualify live prices.
      proofServer=createHttpServer(async(req,res)=>{
        res.setHeader("Content-Type","application/json");res.setHeader("Cache-Control","no-store");
        if(!serviceAvailable){res.writeHead(503);res.end("{}");return;}
        if(req.method!=="GET"||req.url!==`/stock/approvals/${engine}`){res.writeHead(404);res.end("{}");return;}
        try {
          const p=await freshProofs();
          res.end(JSON.stringify({kind:"stock-pool",chainId:4663,engine,pool,collateral,adapter:secondary,...stockDependencies,
            validUntil:Number((await client.getBlock()).timestamp+45n),...p}));
        }catch{res.writeHead(503);res.end("{}");}
      });
      await new Promise<void>(resolve=>proofServer!.listen(0,"127.0.0.1",resolve));
      const address=proofServer.address();assert.ok(address&&typeof address!=="string");
      d.stock!.riskMonitorUrl=`http://127.0.0.1:${address.port}`;
    }
    let clock = (await client.getBlock()).timestamp;
    const now = () => Number(clock*1000n);
    const refreshClock = async () => {clock=(await client.getBlock()).timestamp;};
    const run = async (intent: IsolatedIntent,asBorrower=false) => {
      const account = asBorrower ? borrower : lender, wallet = asBorrower ? borrowerWallet : lenderWallet;
      const steps = [];
      for(let i=0;i<4;i++){
        await refreshClock();
        const before = await client.getTransactionCount({address:account.address});
        const needsProofs = stockMarket && (intent.kind==="borrow" || intent.kind==="depositBorrow"
          || intent.kind==="removeCollateral" && await read(engine,"positionDebt",[account.address])!==0n
          || ["lend","withdraw","redeem"].includes(intent.kind) && await read(pool,"outstandingPrincipal")!==0n);
        const proofs=needsProofs?await fetchStockProofs(d,fetch,now):undefined;
        const beforeGate=stockDependencies?await read(stockDependencies.executionGate,"liveness"):null;
        const step = await prepareIsolatedAction(client,d,account.address,intent,now,proofs);
        if(stockDependencies)assert.deepEqual(await read(stockDependencies.executionGate,"liveness"),beforeGate,"eth_call must not persist proof publication");
        assert.equal(await client.getTransactionCount({address:account.address}),before,"preparation must not broadcast");
        if(step.kind==="approval") {
          const decoded=decodeFunctionData({abi:erc20Abi,data:step.data});
          assert.equal(decoded.functionName,"approve");
          assert.ok(decoded.args && decoded.args[1] !== 2n**256n-1n,"no unlimited approvals");
        }
        // Exercise next-block interest checkpoint changes rather than mining all
        // transactions at the snapshot's timestamp.
        await client.request({method:"evm_setNextBlockTimestamp",params:[Number((await client.getBlock()).timestamp+2n)]} as never);
        const hash = await wallet.sendTransaction({to:step.to,data:step.data,value:step.value,gas:step.gas,chain:null});
        const receipt = await client.waitForTransactionReceipt({hash});
        if (receipt.status !== "success") {
          const transaction = await client.getTransaction({hash});
          throw new Error(`${intent.kind}/${step.kind} reverted: gas used ${receipt.gasUsed}, limit ${transaction.gas}`);
        }
        steps.push(step);
        if(step.kind==="transaction")return steps;
      }
      throw Error("Unexpected approval loop");
    };
    await refreshClock();
    const initial = await readIsolatedMarket(client,d,lender.address,now);
    assert.equal(initial.cash,0n);assert.equal(initial.shares,0n);assert.equal(initial.price,100n*10n**18n);
    // Exercise a partial existing allowance: reset to zero, exact approval, deposit.
    await write(ISOLATED_USDG,"approve",[pool,1n]);await refreshClock();
    const lend = await quoteLenderIntent(client,d,lender.address,"lend",100000000n,50,now);
    const depositSteps = await run(lend);
    assert.equal(depositSteps.length,3);
    assert.equal(decodeFunctionData({abi:erc20Abi,data:depositSteps[0]!.data}).args?.[1],0n);
    assert.equal(decodeFunctionData({abi:isolatedPoolAbi,data:depositSteps[2]!.data}).functionName,"depositWithMinShares");
    await refreshClock();
    let state = await readIsolatedMarket(client,d,lender.address,now);
    assert.equal(state.shares,100n*10n**12n);assert.equal(state.lendAllowance,0n);
    await run(await quoteLenderIntent(client,d,lender.address,"withdraw",25000000n,50,now));
    await run({kind:"depositBorrow",amount:40000000n,collateralAmount:10n**18n},true);
    if(stockMarket){
      await refreshClock();
      const signed=await freshProofs();
      const beforeNonce=await client.getTransactionCount({address:borrower.address});
      const corrupted={...signed,liveness:`${signed.liveness.slice(0,-66)}${"00".repeat(33)}` as Hex};
      await assert.rejects(prepareIsolatedAction(client,d,borrower.address,{kind:"borrow",amount:1000000n},now,corrupted));
      assert.equal(await client.getTransactionCount({address:borrower.address}),beforeNonce,"invalid proofs cannot submit even an approval");
      const expiring=await prepareIsolatedAction(client,d,borrower.address,{kind:"borrow",amount:1000000n},now,signed);
      const beforeCash=await read(pool,"availableCash");
      const beforePrincipal=await read(pool,"outstandingPrincipal");
      // Expire cached proof state: the next lender exit must refresh proofs in
      // its transaction, without a separate user-signed publication transaction.
      await client.request({method:"evm_increaseTime",params:[46]} as never);
      await client.request({method:"evm_mine",params:[]} as never);
      const expiredHash=await borrowerWallet.sendTransaction({to:expiring.to,data:expiring.data,value:0n,gas:expiring.gas,chain:null});
      assert.equal((await client.waitForTransactionReceipt({hash:expiredHash})).status,"reverted","contracts must reject a wallet request mined after proof expiry");
      assert.equal(await read(pool,"availableCash"),beforeCash);
      assert.equal(await read(pool,"outstandingPrincipal"),beforePrincipal);
      await refreshClock();
      assert.equal((await readIsolatedMarket(client,d,lender.address,now)).maxWithdraw,0n);
      const proof=await freshProofs();
      const withdrawal=await quoteLenderIntent(client,d,lender.address,"withdraw",1000000n,50,now,proof);
      const steps=await run(withdrawal);
      assert.equal(decodeFunctionData({abi:isolatedPoolAbi,data:steps.at(-1)!.data}).functionName,"withdrawChecked");
      // Restore one USDG with a checked deposit so both lifecycle paths keep the
      // same cash/debt expectations below (share rounding remains exercised).
      await refreshClock();
      await run(await quoteLenderIntent(client,d,lender.address,"lend",1000000n,50,now,await freshProofs()));
    }
    await refreshClock();
    state=await readIsolatedMarket(client,d,lender.address,now);
    assert.equal(state.maxWithdraw,35000000n);assert.equal(state.cash,35000000n);
    await assert.rejects(prepareIsolatedAction(client,d,lender.address,{kind:"withdraw",amount:36000000n,maxShares:75n*10n**12n,deadline:clock+300n},now,stockMarket?await freshProofs():undefined),/not currently withdrawable/);
    await run({kind:"addCollateral",amount:2n*10n**17n},true);
    await run({kind:"removeCollateral",amount:10n**17n},true);
    await run({kind:"repay",amount:10000000n},true);
    // Interest accrual and oracle outage: repay/top-up/debt-free exit still work.
    await client.request({method:"evm_increaseTime",params:[365*86400]} as never);
    await client.request({method:"evm_mine",params:[]} as never);
    await write(primary,"setShouldRevert",[true]);
    if(!stockMarket)await write(secondary,"setShouldRevert",[true]);
    await write(engine,"setRiskPaused",[true]);await refreshClock();
    serviceAvailable=false;
    state=await readIsolatedMarket(client,d,lender.address,now);
    assert.equal(state.price,null);assert.equal(state.maxWithdraw,0n);
    await assert.rejects(prepareIsolatedAction(client,d,borrower.address,{kind:"borrow",amount:1000000n},now),/unavailable|proofs required/);
    await run({kind:"addCollateral",amount:10n**17n},true);
    await write(ISOLATED_USDG,"mint",[borrower.address,10000000n]);await refreshClock();
    const debt = (await readIsolatedMarket(client,d,borrower.address,now)).debt;
    assert.ok(debt>=33000000n);
    await run({kind:"close",amount:debt+1000n},true);await refreshClock();
    const closed=await readIsolatedMarket(client,d,borrower.address,now);
    assert.equal(closed.debt,0n);assert.equal(closed.collateral,0n);assert.equal(closed.collateralBalance,3n*10n**18n);
    state=await readIsolatedMarket(client,d,lender.address,now);
    assert.ok(state.maxWithdraw>75000000n);assert.equal(state.maxRedeem,state.shares);
    await run(await quoteLenderIntent(client,d,lender.address,"redeem",state.shares,50,now));await refreshClock();
    assert.equal((await readIsolatedMarket(client,d,lender.address,now)).shares,0n);
    await assert.rejects(readIsolatedMarket(client,{...d,hashes:{...d.hashes,pool:`0x${"00".repeat(32)}`}},lender.address,now),/runtime/);
    await assert.rejects(readIsolatedMarket(client,d,lender.address,() => Number((clock+61n)*1000n)),/stale/);
    console.log(JSON.stringify({evidence:"isolated-wallet-local-lifecycle",stockMarket,mockTokens:true,mockOracles:true,
      actualContracts:true,protectedLenderCalls:true,boundedApprovals:true,oracleOutageClose:true,lenderFullyExited:true,productionChanged:false}));
  } finally {
    if(proofServer){proofServer.closeAllConnections();await new Promise<void>(resolve=>proofServer!.close(()=>resolve()));}
    if(child.exitCode===null){child.kill("SIGTERM");await new Promise<void>(resolve=>{
      const timer=setTimeout(()=>{child.kill("SIGKILL");resolve();},3000);
      child.once("exit",()=>{clearTimeout(timer);resolve();});
    });}
  }
});
