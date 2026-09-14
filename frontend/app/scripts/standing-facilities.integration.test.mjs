import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {createServer as createHTTPServer} from 'node:http';
import {pathToFileURL} from 'node:url';
import {readFile,mkdtemp,rm,mkdir,copyFile,writeFile} from 'node:fs/promises';
import {tmpdir,homedir} from 'node:os';
import {join} from 'node:path';
import {createPublicClient,createWalletClient,defineChain,http,keccak256} from 'viem';
import {mnemonicToAccount} from 'viem/accounts';
import {captureTokenBaseline} from '../src/p2p/health-core.mjs';
import {createStandingAccountIndex} from './standing-account-index.mjs';
import {createStandingDirectory} from './standing-facilities.mjs';
import {createFacilityQuoteBoard,openFacilityQuoteStore} from './facility-quotes.mjs';
import {createFacilityLoanIndex} from './facility-loan-index.mjs';
import {quoteTypedData,ZERO_ADDRESS} from '../src/facilities/quotes.mjs';

test('standing facilities verify origin, persist, share budget and discover loans',{timeout:90000},async()=>{
 const reserve=createServer();await new Promise(r=>reserve.listen(0,'127.0.0.1',r));const port=reserve.address().port;await new Promise(r=>reserve.close(r));
 const child=spawn(`${homedir()}/.foundry/bin/anvil`,['--host','127.0.0.1','--port',String(port),'--chain-id','31337','--silent'],{stdio:'ignore'});
 const url=`http://127.0.0.1:${port}`,chain=defineChain({id:31337,name:'Standing test',nativeCurrency:{name:'ETH',symbol:'ETH',decimals:18},rpcUrls:{default:{http:[url]}}});
 const client=createPublicClient({chain,transport:http(url,{retryCount:0}),pollingInterval:10});
 const accounts=[0,1,2].map(addressIndex=>mnemonicToAccount('test test test test test test test test test test test junk',{addressIndex}));
 const wallet=a=>createWalletClient({account:a,chain,transport:http(url),pollingInterval:10});
 const temp=await mkdtemp(join(tmpdir(),'standing-integration-')),databasePath=join(temp,'state.sqlite');let directory,store,index,accountIndex;
 try{
  let ready=false;for(let i=0;i<100;i++){try{ready=await client.getChainId()===31337;}catch{}if(ready)break;await new Promise(r=>setTimeout(r,30));}assert(ready);
  const artifact=async(file,name=file)=>JSON.parse(await readFile(new URL(`../../../contracts/p2p/out/${file}.sol/${name}.json`,import.meta.url),'utf8'));
  const [token,factory,facility]=await Promise.all([artifact('V3TestSupport','V3TestToken'),artifact('TurretLenderFacilityFactory'),artifact('TurretLenderFacility')]);
  const receipt=async hash=>{const r=await client.waitForTransactionReceipt({hash});assert.equal(r.status,'success');return r;};
  const deploy=async(a,args)=>(await receipt(await wallet(accounts[0]).deployContract({abi:a.abi,bytecode:a.bytecode.object,args}))).contractAddress;
  const write=async(a,address,abi,functionName,args=[])=>receipt(await wallet(a).writeContract({address,abi,functionName,args}));
  const loanToken=await deploy(token,['USDG',6]),collateralToken=await deploy(token,['PONS',18]);
  const factoryAddress=await deploy(factory,[loanToken,[collateralToken]]);const b=await client.getBlock();
  const config={schemaVersion:1,chainId:31337,factory:factoryAddress,runtimeHash:keccak256(await client.getCode({address:factoryAddress})),loanToken,startBlock:String(b.number),collateral:[{address:collateralToken,symbol:'PONS',name:'Pons',decimals:18}],
   baseline:{schemaVersion:1,chainId:31337,blockNumber:String(b.number),blockHash:b.hash,tokens:await Promise.all([loanToken,collateralToken].map(a=>captureTokenBaseline(client,a,b,factoryAddress)))}};
  const policy={maxExposure:100000000n,minDraw:10000000n,maxDraw:50000000n,minDuration:1209600n,maxDuration:1209600n,maxQuoteLifetime:86400n,minCollateralPerPrincipalWad:4n*10n**30n,minInterestBps:600n};
  await write(accounts[0],factoryAddress,factory.abi,'createFacility',[collateralToken,policy]);
  const address=await client.readContract({address:factoryAddress,abi:factory.abi,functionName:'getFacility',args:[accounts[0].address,collateralToken]});
  const options={config,client,databasePath,origin:'http://localhost'};directory=createStandingDirectory(options);
  const entry=await directory.register(address);assert.equal(entry.lender.toLowerCase(),accounts[0].address.toLowerCase());assert.equal(entry.feeBps,'0');
  assert.equal(directory.list().entries.length,1);await directory.register(address);assert.equal(directory.list().entries.length,1);
  assert.equal(directory.list({lender:accounts[1].address}).entries.length,0);
  const spoof=await deploy(facility,[loanToken,collateralToken,accounts[0].address,accounts[0].address,0n,policy]);await assert.rejects(directory.register(spoof),/verified factory/);
  await assert.rejects(directory.resolveEntry(4663,address),/Invalid/);
  directory.close();directory=createStandingDirectory(options);assert.equal((await directory.resolveEntry(31337,address)).address,entry.address);
  store=openFacilityQuoteStore(databasePath);const board=createFacilityQuoteBoard({entries:[],baseline:config.baseline,client,store,resolveEntry:directory.resolveEntry});
  const now=(await client.getBlock()).timestamp;
  const quote={schemaVersion:1,chainId:31337,facility:address,signature:'0x',quote:{epoch:'1',nonce:'1',borrower:ZERO_ADDRESS,capacity:'100000000',minDraw:'10000000',collateralForCapacity:String(400n*10n**18n),interestForCapacity:'6000000',duration:'1209600',validAfter:String(now),expiresAt:String(now+3600n)}};
  quote.signature=await accounts[0].signTypedData(quoteTypedData(quote));await board.submit(quote);assert.equal((await board.list({chainId:31337,facility:address})).capacity,0n);
  await write(accounts[0],loanToken,token.abi,'mint',[accounts[0].address,100000000n]);await write(accounts[0],loanToken,token.abi,'approve',[address,100000000n]);await write(accounts[0],address,facility.abi,'deposit',[100000000n]);
  assert.equal((await board.list({chainId:31337,facility:address})).capacity,100000000n);assert.equal(directory.list({available:true}).entries.length,1);
  const snapshot=await client.request({method:'evm_snapshot'});
  const q=Object.fromEntries(Object.entries(quote.quote).map(([k,v])=>[k,k==='borrower'?v:BigInt(v)]));
  for(const a of accounts.slice(1)){await write(accounts[0],collateralToken,token.abi,'mint',[a.address,200n*10n**18n]);await write(a,collateralToken,token.abi,'approve',[address,200n*10n**18n]);await write(a,address,facility.abi,'draw',[q,quote.signature,50000000n,200n*10n**18n,3000000n,50000000n]);}
  assert.equal((await board.list({chainId:31337,facility:address})).capacity,0n);
  // An unrelated clone emits a real LoanOpened event for the same borrower.
  // Wallet-wide discovery must exclude it because the pinned factory did not create it.
  await write(accounts[0],loanToken,token.abi,'mint',[accounts[0].address,50000000n]);
  await write(accounts[0],loanToken,token.abi,'approve',[spoof,50000000n]);
  await write(accounts[0],spoof,facility.abi,'deposit',[50000000n]);
  await write(accounts[0],collateralToken,token.abi,'mint',[accounts[1].address,200n*10n**18n]);
  await write(accounts[1],collateralToken,token.abi,'approve',[spoof,200n*10n**18n]);
  const spoofSignature=await accounts[0].signTypedData(quoteTypedData({...quote,facility:spoof}));
  await write(accounts[1],spoof,facility.abi,'draw',[q,spoofSignature,50000000n,200n*10n**18n,3000000n,50000000n]);
  index=createFacilityLoanIndex({entries:[],baseline:config.baseline,client,databasePath,resolveEntry:directory.resolveEntry});
  accountIndex=createStandingAccountIndex({config,client,directory,databasePath});
  const discovered=await accountIndex.list({account:accounts[1].address});assert.equal(discovered.entries.length,1);assert.equal(discovered.complete,true);
  assert.equal((await accountIndex.list({account:accounts[0].address})).entries.length,1,'lender mapping finds the standing balance');
  accountIndex.close();accountIndex=createStandingAccountIndex({config,client,directory,databasePath});
  assert.equal((await accountIndex.list({account:accounts[1].address})).entries.length,1,'borrower discovery survives restart');
  // Cold cache eviction never loses recoverability or accepts a stale pagination epoch.
  accountIndex.close();accountIndex=createStandingAccountIndex({config,client,directory,databasePath,maxAccounts:2});
  await accountIndex.list({account:accounts[0].address});
  await accountIndex.list({account:accounts[2].address});
  await assert.rejects(accountIndex.list({account:accounts[1].address,epoch:String(discovered.historyEpoch)}),/history changed/);
  const recovered=await accountIndex.list({account:accounts[1].address});assert.equal(recovered.entries.length,1);assert.equal(recovered.complete,true);
  // A bounded first scan reports incomplete history, never a definitive empty wallet.
  const bounded=createStandingAccountIndex({config,client,directory,databasePath:join(temp,'bounded.sqlite'),pageBlocks:1n,maxPages:1});
  try{
   let page=await bounded.list({account:accounts[1].address});assert.equal(page.complete,false);assert.equal(page.entries.length,0);
   for(let i=0;i<40&&!page.complete;i++)page=await bounded.list({account:accounts[1].address});
   assert.equal(page.complete,true);assert.equal(page.entries.length,1);
  }finally{bounded.close();}
  if(process.env.STANDING_BUNDLE_TEST){
   const bundleDir=join(temp,'bundle');await mkdir(join(bundleDir,'scripts'),{recursive:true});await mkdir(join(bundleDir,'public'));
   await copyFile(process.env.STANDING_BUNDLE_TEST,join(bundleDir,'scripts','standing-platform.bundle.mjs'));
   await writeFile(join(bundleDir,'public','standing-offers.json'),JSON.stringify(config));
   const envBefore={database:process.env.FACILITY_QUOTES_DATABASE,origin:process.env.FACILITY_ORIGIN};
   let httpServer;
   try{
    process.env.FACILITY_QUOTES_DATABASE=databasePath;process.env.FACILITY_ORIGIN='http://localhost';
    const {createStandingAPI}=await import(pathToFileURL(join(bundleDir,'scripts','standing-platform.bundle.mjs')).href);
    const api=createStandingAPI(client);
    httpServer=createHTTPServer(async(req,res)=>{if(!await api(req,res,{}))res.writeHead(404).end();});
    await new Promise(resolve=>httpServer.listen(0,'127.0.0.1',resolve));const origin=`http://127.0.0.1:${httpServer.address().port}`;
    const configResponse=await fetch(origin+'/standing-offers.json');assert.equal(configResponse.status,200);assert.equal(configResponse.headers.get('cache-control'),'no-store');assert.deepEqual(await configResponse.json(),config);
    const globalResponse=await fetch(origin+'/api/standing-account?account='+accounts[1].address);assert.equal(globalResponse.status,200);
    const globalBody=await globalResponse.json();assert.equal(globalBody.entries.length,1);assert.equal(globalBody.entries[0].address.toLowerCase(),address.toLowerCase());
    const offers=await fetch(origin+'/api/facility-quotes?chainId=31337&facility='+address);assert.equal(offers.status,200);
    const loans=await fetch(origin+'/api/facility-loans?chainId=31337&facility='+address+'&account='+accounts[1].address);assert.equal(loans.status,200);assert.equal((await loans.json()).rows.length,1);
    const invalid=await fetch(origin+'/api/standing-account?account='+accounts[1].address+'&account='+accounts[2].address);assert.equal(invalid.status,400);
   }finally{
    if(httpServer)await new Promise(resolve=>httpServer.close(resolve));
    if(envBefore.database===undefined)delete process.env.FACILITY_QUOTES_DATABASE;else process.env.FACILITY_QUOTES_DATABASE=envBefore.database;
    if(envBefore.origin===undefined)delete process.env.FACILITY_ORIGIN;else process.env.FACILITY_ORIGIN=envBefore.origin;
   }
  }
  const history=await index.list({chainId:31337,facility:address,account:accounts[0].address});assert.equal(history.rows.length,2);assert.equal(history.complete,true);
  assert.equal((await index.list({chainId:31337,facility:address,account:accounts[1].address})).rows.length,1);
  await write(accounts[0],loanToken,token.abi,'mint',[accounts[1].address,3000000n]);await write(accounts[1],loanToken,token.abi,'approve',[address,53000000n]);await write(accounts[1],address,facility.abi,'repay',[1n]);await write(accounts[0],address,facility.abi,'recycleRepayment',[1n]);
  assert.equal((await board.list({chainId:31337,facility:address})).capacity,0n,'recycling cannot renew a filled authorization');
  await write(accounts[0],address,facility.abi,'withdrawIdle',[53000000n,accounts[0].address]);
  await client.request({method:'evm_revert',params:[snapshot]});
  const afterReorg=await accountIndex.list({account:accounts[1].address});assert.equal(afterReorg.entries.length,0);assert.equal(afterReorg.complete,true);assert.ok(afterReorg.historyEpoch>discovered.historyEpoch);
  await assert.rejects(accountIndex.list({account:accounts[1].address,epoch:String(discovered.historyEpoch)}),/history changed/);
  assert.equal((await accountIndex.list({account:accounts[0].address})).entries.length,1,'reorg does not erase the lender facility created before the snapshot');
  const other=createStandingDirectory({...options,config:{...config,runtimeHash:'0x'+'ff'.repeat(32)}});try{await assert.rejects(other.register(address),/factory identity/);}finally{other.close();}
 }finally{accountIndex?.close();index?.close();store?.close();directory?.close();child.kill('SIGTERM');await rm(temp,{recursive:true,force:true});}
});
