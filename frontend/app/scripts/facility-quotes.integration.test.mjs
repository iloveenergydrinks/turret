import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createPublicClient, createWalletClient, defineChain, http, keccak256 } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { captureTokenBaseline } from "../src/p2p/health-core.mjs";
import { assessQuote, drawAmounts, quoteDigest, quoteTypedData, quoteValues, summarizeFacilities, ZERO_ADDRESS, ZERO_HASH } from "../src/facilities/quotes.mjs";
import { readFacilityQuotes } from "../src/facilities/reader.mjs";
import { createFacilityQuoteBoard, openFacilityQuoteStore } from "./facility-quotes.mjs";
import { createFacilityPlatform } from "./facility-platform.mjs";
import { reconcileFacilityFees } from "../src/facilities/fee-reconciliation.mjs";
import { auditFeeJournal } from "./facility-fee-audit.mjs";
import { openFacilityFeeIntents } from "./facility-fee-intents.mjs";

// Dedicated local chain only. No external endpoint, wallet secret or mainnet write is accepted.
test("facility quote reader follows deployed contract hashing, shared cash, fills, repayment, revocation and ERC-1271",{timeout:60_000},async()=>{
  const reservation=createServer();await new Promise(resolve=>reservation.listen(0,"127.0.0.1",resolve));
  const port=reservation.address().port;await new Promise(resolve=>reservation.close(resolve));
  const anvil=spawn(`${homedir()}/.foundry/bin/anvil`,["--host","127.0.0.1","--port",String(port),"--chain-id","31337","--silent"],{stdio:"ignore"});
  let startupError;anvil.on("error",e=>{startupError=e;});
  const url=`http://127.0.0.1:${port}`;
  const chain=defineChain({id:31337,name:"Facility test",nativeCurrency:{name:"Test ETH",symbol:"ETH",decimals:18},rpcUrls:{default:{http:[url]}}});
  const client=createPublicClient({chain,transport:http(url,{retryCount:0}),pollingInterval:10});
  const [lender,borrower,fees]=[0,1,2].map(addressIndex=>mnemonicToAccount("test test test test test test test test test test test junk",{addressIndex}));
  const wallet=account=>createWalletClient({account,chain,transport:http(url),pollingInterval:10});
  const directory=await mkdtemp(join(tmpdir(),"facility-real-chain-"));let store, platform, server, feeIntents, competingIntents;
  try {
    let ready=false;
    for(let i=0;i<100;i++) {
      if(startupError)throw startupError;
      try {ready=await client.getChainId()===31337;}catch{}
      if(ready)break;
      await new Promise(r=>setTimeout(r,30));
    }
    assert(ready);assert.match(await client.request({method:"web3_clientVersion"}),/anvil/i);
    const artifact=async(file,name=file)=>JSON.parse(await readFile(new URL(`../../../contracts/p2p/out/${file}.sol/${name}.json`,import.meta.url),"utf8"));
    const [token,facility,signerArtifact]=await Promise.all([artifact("V3TestSupport","V3TestToken"),artifact("TurretLenderFacility"),artifact("LenderFacility.t","Facility1271Signer")]);
    const receipt=async hash=>{const r=await client.waitForTransactionReceipt({hash});assert.equal(r.status,"success");return r;};
    const deploy=async(art,args)=>(await receipt(await wallet(lender).deployContract({abi:art.abi,bytecode:art.bytecode.object,args}))).contractAddress;
    const write=async(account,address,abi,functionName,args=[])=>receipt(await wallet(account).writeContract({address,abi,functionName,args}));
    const loanToken=await deploy(token,["USDG",6]),collateralToken=await deploy(token,["MEME",18]);
    const limits={maxExposure:500_000000n,minDraw:1_000000n,maxDraw:300_000000n,minDuration:86400n,maxDuration:2592000n,
      maxQuoteLifetime:3600n,minCollateralPerPrincipalWad:10n**30n,minInterestBps:100n};
    const address=await deploy(facility,[loanToken,collateralToken,lender.address,fees.address,1000n,limits]);
    const read=(functionName,args=[])=>client.readContract({address,abi:facility.abi,functionName,args});
    await write(lender,loanToken,token.abi,"mint",[lender.address,500_000000n]);
    await write(lender,collateralToken,token.abi,"mint",[borrower.address,2000n*10n**18n]);
    await write(lender,loanToken,token.abi,"approve",[address,500_000000n]);
    await write(lender,address,facility.abi,"deposit",[500_000000n]);
    await write(borrower,collateralToken,token.abi,"approve",[address,2000n*10n**18n]);
    const block=await client.getBlock();
    const baseline={schemaVersion:1,chainId:31337,blockNumber:String(block.number),blockHash:block.hash,
      tokens:await Promise.all([loanToken,collateralToken].map(a=>captureTokenBaseline(client,a,block,address)))};
    const vaultImplementation=await read("vaultImplementation");
    const entry={chainId:31337,address,lender:lender.address,loanToken,collateralToken,feeRecipient:fees.address,feeBps:"1000",startBlock:String(block.number),vaultImplementation,
      runtimeHash:keccak256(await client.getCode({address})),vaultImplementationHash:keccak256(await client.getCode({address:vaultImplementation}))};
    const make=async(nonce,signingAccount=lender)=>{
      const b=await client.getBlock();
      const e={schemaVersion:1,chainId:31337,facility:address,signature:"0x",quote:{epoch:String(await read("epoch")),nonce:String(nonce),borrower:ZERO_ADDRESS,
        capacity:"300000000",minDraw:"1000000",collateralForCapacity:"600000000000000000000",interestForCapacity:"30000000",duration:"604800",
        validAfter:String(b.timestamp),expiresAt:String(b.timestamp+600n)}};
      if(signingAccount)e.signature=await signingAccount.signTypedData(quoteTypedData(e));
      return e;
    };
    const a=await make(1),b=await make(2);
    const file=join(directory,"quotes.sqlite");store=openFacilityQuoteStore(file);
    const newBoard=()=>createFacilityQuoteBoard({entries:[entry],baseline,client,store});
    let board=newBoard();
    server=createHttpServer((req,res)=>void platform(req,res,{"x-test-mount":"facility"}).then(handled=>{if(!handled){res.writeHead(404);res.end();}}));
    await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
    const origin=`http://127.0.0.1:${server.address().port}`;
    platform=createFacilityPlatform({config:{schemaVersion:1,entries:[entry],baseline},client,origin,databasePath:file});
    const post=(body,headers={})=>fetch(`${origin}/api/facility-quotes`,{method:"POST",headers:{origin,"content-type":"application/json",...headers},body,duplex:"half"});
    assert.equal((await post(JSON.stringify(a),{origin:"https://other.example"})).status,403);
    assert.equal((await post(" ".repeat(17000))).status,413);
    assert.equal((await post(new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode(" ".repeat(17000)));controller.close();}}))).status,413,"chunked bodies obey the same limit");
    assert.equal((await post("{")).status,400);
    assert.equal((await fetch(`${origin}/api/facility-quotes`,{method:"DELETE"})).status,405);
    assert.equal((await fetch(`${origin}/unrelated-route`)).status,404);
    for(const envelope of [a,b]) {
      const response=await post(JSON.stringify(envelope));
      assert.equal(response.headers.get("x-test-mount"),"facility");
      assert.equal(response.status,200,JSON.stringify(await response.json()));
    }
    assert.equal(quoteDigest(a),await read("quoteHash",[quoteValues(a.quote)]),"browser EIP-712 digest must equal contract digest");
    const terms=drawAmounts(a,100_000001n,1000n);
    assert.deepEqual(await read("quoteTerms",[quoteValues(a.quote),100_000001n]),[terms.collateral,terms.interest]);
    const savedQuotes=[a,b];
    const check=async(quotes=savedQuotes,c=client,admission=entry,qualified=baseline)=>{
      const snapshot=await readFacilityQuotes(c,admission,qualified,quotes);
      const group=summarizeFacilities(snapshot.rows,{now:snapshot.checkedAt,account:borrower.address})[0];
      if(quotes===savedQuotes&&c===client&&admission===entry&&qualified===baseline) {
        const listed=await board.list({chainId:31337,facility:address,account:borrower.address});
        assert.equal(listed.capacity,group.capacity,"persistent directory must match freshly read chain capacity");
        const response=await fetch(`${origin}/api/facility-quotes?chainId=31337&facility=${address}&account=${borrower.address}`);
        assert.equal(response.status,200); assert.equal(response.headers.get("cache-control"),"no-store");
        const publicList=await response.json();
        assert.equal(publicList.capacity,String(group.capacity),"website mount must expose current contract capacity");
      }
      return {...snapshot,group};
    };
    let s=await check();assert.equal(s.group.capacity,500_000000n);assert.equal(s.group.quotes.length,2);
    const draw=async(e,p)=>{
      const t=drawAmounts(e,p,1000n);
      return write(borrower,address,facility.abi,"draw",[quoteValues(e.quote),e.signature,p,t.collateral,t.interest,p]);
    };
    await draw(a,100_000000n);
    const history=async()=>{
      const result=await fetch(`${origin}/api/facility-loans?chainId=31337&facility=${address}&account=${borrower.address}`);
      assert.equal(result.status,200);return result.json();
    };
    let loans=await history();assert.equal(loans.complete,true);assert.equal(loans.rows[0].id,"1");assert.equal(loans.rows[0].status,1);
    store.close();store=openFacilityQuoteStore(file);board=newBoard();
    s=await check();assert.equal(s.group.capacity,400_000000n);assert.equal(s.rows[0].observation.use.filled,100_000000n);
    assert.equal(s.group.quotes[0].availability.capacity,200_000000n);
    await write(lender,loanToken,token.abi,"mint",[borrower.address,10_000000n]);
    await write(borrower,loanToken,token.abi,"approve",[address,110_000000n]);
    await write(borrower,address,facility.abi,"repay",[1n]);
    loans=await history();assert.equal(loans.rows[0].status,2,"repaid loans remain discoverable for withdrawals");
    s=await check();assert.equal(s.group.capacity,400_000000n,"repayment vault credit is not idle cash");
    await write(borrower,address,facility.abi,"recycleRepayment",[1n]);
    s=await check();assert.equal(s.group.capacity,500_000000n,"exposure limit caps recycled cash of 509 USDG");
    assert.equal(s.rows[0].observation.use.filled,100_000000n,"repayment never resets signed capacity");
    // Existing staking router integration: an actual collected fee is remitted by treasury.
    const rewardArtifact=async name=>JSON.parse(await readFile(new URL(`../../../contracts/rewards/out/${name}.sol/${name}.json`,import.meta.url),"utf8"));
    const poolArtifact=await rewardArtifact("DockyardIsolatedCapitalPool"),routerArtifact=await rewardArtifact("TurretRecoverableFeeRouter");
    const pool=await deploy(poolArtifact,[loanToken,collateralToken,address,fees.address,1_000_000_000000n,1000n,1000n]);
    const router=await deploy(routerArtifact,[collateralToken,loanToken,fees.address,[pool]]);
    const staking=await client.readContract({address:router,abi:routerArtifact.abi,functionName:"staking"});
    const checkpoint=await client.getBlock();
    const feeConfig={chainId:31337,facilities:[entry],treasury:fees.address,router,staking,usdg:loanToken,tokenBaseline:baseline,
      routerRuntimeHash:keccak256(await client.getCode({address:router})),stakingRuntimeHash:keccak256(await client.getCode({address:staking})),usdgRuntimeHash:keccak256(await client.getCode({address:loanToken}))};
    const feeBaseline={blockNumber:String(checkpoint.number),blockHash:checkpoint.hash,totalTreasuryReported:"0"};
    const audit=(collectionHashes=[],remittances=[],overrides={})=>reconcileFacilityFees({client,config:feeConfig,baseline:feeBaseline,collectionHashes,remittances,...overrides});
    assert.equal((await audit()).plan,null,"uncollected loan credit does not count as treasury revenue");
    const collectedReceipt=await write(borrower,address,facility.abi,"collectFee",[1n]);
    await assert.rejects(audit([collectedReceipt.transactionHash]),/unconfirmed/);
    for(let i=0;i<2;i++)await client.request({method:"evm_mine",params:[]});
    const feeAudit=await audit([collectedReceipt.transactionHash]);assert.equal(feeAudit.gross,1_000000n);assert.equal(feeAudit.expectedStakerShare,500000n);
    const operatorReport=await auditFeeJournal({client,config:feeConfig,journal:{schemaVersion:1,baseline:feeBaseline,collectionHashes:[collectedReceipt.transactionHash],remittances:[]}});
    assert.equal(operatorReport.readyToForward,false);assert.equal(operatorReport.approval.maximumAmount,500000n);assert.deepEqual(operatorReport.plan,feeAudit.plan);
    const intentPath=join(directory,"fee-intents.sqlite"), intentOptions={client,config:feeConfig,journal:{schemaVersion:1,baseline:feeBaseline,collectionHashes:[collectedReceipt.transactionHash],remittances:[]}};
    feeIntents=openFacilityFeeIntents(intentPath,intentOptions);competingIntents=openFacilityFeeIntents(intentPath,intentOptions);
    const reservations=await Promise.allSettled([feeIntents.reserve(),competingIntents.reserve()]);
    assert.equal(reservations.filter(result=>result.status==="fulfilled").length,1,"two database connections cannot reserve the same fees");
    let intent=feeIntents.active();assert.equal(intent.state,"reserved");
    await assert.rejects(feeIntents.beginSigning(intent.id),/balance or allowance/);
    feeIntents.cancelReserved(intent.id);assert.equal(competingIntents.active(),null);
    intent=await feeIntents.reserve();
    assert.throws(()=>openFacilityFeeIntents(intentPath,{...intentOptions,config:{...feeConfig,treasury:borrower.address}}),/identity changed/);
    await assert.rejects(client.simulateContract({account:borrower.address,address:router,abi:routerArtifact.abi,functionName:"forwardClaimedFees",args:[feeAudit.gross]}));
    await assert.rejects(audit([collectedReceipt.transactionHash,collectedReceipt.transactionHash]),/configuration/);
    await assert.rejects(audit([collectedReceipt.transactionHash],[],{client:{...client,getChainId:async()=>4663}}),/chain mismatch/);
    await assert.rejects(audit([collectedReceipt.transactionHash],[],{client:{...client,getBlock:async args=>{
      const value=await client.getBlock(args);return args?.blockNumber===collectedReceipt.blockNumber?{...value,hash:ZERO_HASH}:value;
    }}}),/orphaned/);
    await assert.rejects(audit([collectedReceipt.transactionHash],[],{client:{...client,getStorageAt:async args=>
      args.address.toLowerCase()===loanToken.toLowerCase()?`0x${"0".repeat(63)}1`:client.getStorageAt(args)
    }}),/verification failed/);
    await assert.rejects(audit([collectedReceipt.transactionHash],[],{client:{...client,getTransactionReceipt:async args=>{
      const value=await client.getTransactionReceipt(args);return {...value,logs:value.logs.filter(log=>log.address.toLowerCase()!==loanToken.toLowerCase())};
    }}}),/actual USDG transfer/);
    await write(fees,loanToken,token.abi,"approve",[router,feeAudit.maximumStakerShare]);
    assert.equal((await audit([collectedReceipt.transactionHash])).readyToForward,true);
    intent=await feeIntents.beginSigning(intent.id);
    feeIntents.close();feeIntents=openFacilityFeeIntents(intentPath,intentOptions);
    assert.equal(feeIntents.active().state,"signing","crash before a transaction hash retains the reservation");
    assert.throws(()=>feeIntents.cancelReserved(intent.id),/expected reserved/);
    await assert.rejects(competingIntents.reserve(),/already active/);
    const remittedReceipt=await receipt(await wallet(fees).sendTransaction({to:intent.plan.to,data:intent.plan.data,value:0n,nonce:Number(intent.nonce)}));
    await assert.rejects(feeIntents.recordSubmission(intent.id,collectedReceipt.transactionHash),/does not match/);
    await feeIntents.recordSubmission(intent.id,remittedReceipt.transactionHash);
    await assert.rejects(feeIntents.confirm(intent.id),/unconfirmed/);
    assert.equal(competingIntents.active().state,"submitted");
    for(let i=0;i<2;i++)await client.request({method:"evm_mine",params:[]});
    assert.equal((await feeIntents.confirm(intent.id)).state,"confirmed");
    assert.equal(competingIntents.active(),null);
    assert.equal(competingIntents.snapshot().journal.remittances[0].hash,remittedReceipt.transactionHash.toLowerCase());
    await assert.rejects(feeIntents.reserve(),/No unassigned/);
    const remittance={hash:remittedReceipt.transactionHash,collectionIds:feeAudit.unassigned.map(row=>row.id)};
    const reconciled=await audit([collectedReceipt.transactionHash],[remittance]);assert.equal(reconciled.forwarded,1_000000n);assert.equal(reconciled.gross,0n);assert.equal(reconciled.plan,null);
    assert.equal(await client.readContract({address:loanToken,abi:token.abi,functionName:"balanceOf",args:[staking]}),500000n);
    await assert.rejects(audit([collectedReceipt.transactionHash]),/Unjournaled treasury forwarding/);
    await assert.rejects(audit([collectedReceipt.transactionHash],[remittance,remittance]),/duplicate fee remittance/);
    await assert.rejects(audit([collectedReceipt.transactionHash],[{...remittance,collectionIds:[...remittance.collectionIds,...remittance.collectionIds]}]),/already assigned/);
    await write(lender,address,facility.abi,"cancelQuote",[1n]);
    s=await check();assert.equal(s.group.capacity,300_000000n);assert.equal(s.group.quotes[0].availability.status,"revoked");
    await write(lender,address,facility.abi,"setNewLoansPaused",[true]);
    assert.equal((await check()).group.capacity,0n);
    await write(lender,address,facility.abi,"setNewLoansPaused",[false]);
    await write(lender,address,facility.abi,"withdrawIdle",[500_000000n,lender.address]);
    assert.equal((await check()).group.capacity,9_000000n);
    await write(lender,address,facility.abi,"setPolicy",[limits,fees.address]);
    assert.equal((await check()).group.capacity,0n);
    const delegated=await make(3,fees);assert.equal((await check([delegated])).group.capacity,9_000000n);
    await draw(delegated,1_000000n);
    const contractSigner=await deploy(signerArtifact,[]);
    await write(lender,address,facility.abi,"setPolicy",[limits,contractSigner]);
    const contractQuote=await make(4,null);
    await write(lender,contractSigner,signerArtifact.abi,"approve",[quoteDigest(contractQuote)]);
    assert.equal((await check([contractQuote])).group.capacity,8_000000n);
    await draw(contractQuote,1_000000n);
    await write(lender,contractSigner,signerArtifact.abi,"approve",[ZERO_HASH]);
    assert.equal((await check([contractQuote])).group.quotes[0].availability.status,"revoked");
    const writingArtifact=await artifact("LenderFacility.t","FacilityWriting1271Signer");
    const writingSigner=await deploy(writingArtifact,[]);
    await write(lender,address,facility.abi,"setPolicy",[limits,writingSigner]);
    const writingQuote=await make(6,null);
    assert.equal(await client.readContract({address:writingSigner,abi:writingArtifact.abi,functionName:"isValidSignature",args:[quoteDigest(writingQuote),"0x"]}),"0x1626ba7e",
      "raw RPC call misleadingly allows the state-writing signer");
    assert.equal((await check([writingQuote])).group.quotes[0].availability.status,"revoked",
      "facility view correctly uses STATICCALL and rejects the same signer");
    await assert.rejects(board.submit(writingQuote),e=>e.status===409);
    const ownerQuote=await make(5);
    assert.equal((await check([ownerQuote])).group.capacity,7_000000n,"lender still authorizes quotes with delegated signer configured");
    // Identity, chain, canonicality and RPC failures cannot produce a healthy empty listing.
    await assert.rejects(check([ownerQuote],{...client,getChainId:async()=>4663}),/chain mismatch/);
    await assert.rejects(check([ownerQuote],client,{...entry,runtimeHash:ZERO_HASH}),/identity changed/);
    await assert.rejects(check([ownerQuote],client,{...entry,feeBps:"999"}),/fee configuration/);
    await assert.rejects(check([ownerQuote],{...client,getBlock:async args=>{
      const r=await client.getBlock(args);return args?.blockNumber!==undefined?{...r,hash:ZERO_HASH}:r;
    }}),/block changed/);
    await assert.rejects(check([ownerQuote],{...client,readContract:async args=>{
      if(args.functionName==="quoteUses")throw new Error("RPC unavailable");return client.readContract(args);
    }}),/RPC unavailable/);
    const changed=structuredClone(baseline);changed.tokens[0].runtimeHash=ZERO_HASH;
    await assert.rejects(check([ownerQuote],client,entry,changed),/Token code or configuration changed/);
    await write(lender,loanToken,token.abi,"removeBalance",[address,1n]);
    s=await check([ownerQuote]);assert.equal(s.group.status,"unavailable");assert.equal(s.group.capacity,0n);
    await write(lender,address,facility.abi,"acknowledgeIdleLoss");
    s=await check([ownerQuote]);assert.equal(s.group.capacity,6_999999n);
    assert.equal(assessQuote(ownerQuote,s.rows[0].observation,{now:s.checkedAt}).status,"available");
  }finally {
    if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
    platform?.close();anvil.kill("SIGTERM");store?.close();feeIntents?.close();competingIntents?.close();await rm(directory,{recursive:true,force:true});
  }
});
