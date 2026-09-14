// Local-only browser E2E harness. Uses the public Anvil mnemonic; never deploy this file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { createServer as createHTTPServer } from 'node:http';
import { tmpdir, homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, createWalletClient, http, maxUint256, keccak256 } from 'viem';
import { mnemonicToAccount } from 'viem/accounts';
import { CashbackLedger } from '../src/ledger.mjs';
import { readCanonicalBlock, syncLedger } from '../src/chain.mjs';
import { preparePublication } from '../src/publication.mjs';
import { createRewardsServer } from '../src/http.mjs';
import { startRuntime } from '../src/runtime.mjs';
import { saveAllocation } from '../src/archive.mjs';
import { buildAllocation } from '../src/merkle.mjs';
import { CashbackClaimReverted, previewCashbackClaim, submitCashbackClaim, verifyCashbackClaim } from '../../../frontend/app/src/borrower-cashback/transactions.ts';

const root = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const rewards = join(root, 'contracts/rewards');
const central = join(root, 'output/central-credit-20260908/contracts');
const artifact = (base, file, name) => JSON.parse(readFileSync(join(base, 'out', file, `${name}.json`), 'utf8'));
const day = 86400;

async function run() {
  execFileSync(join(homedir(), '.foundry/bin/forge'), ['build', '--silent'], { cwd: rewards, stdio: 'pipe' });
  execFileSync(join(homedir(), '.foundry/bin/forge'), ['build', '--silent'], { cwd: central, stdio: 'pipe' });
  const portServer = createServer();
  await new Promise(resolve => portServer.listen(0, '127.0.0.1', resolve));
  const port = portServer.address().port;
  await new Promise(resolve => portServer.close(resolve));
  const directory = mkdtempSync(join(tmpdir(), 'turret-cashback-chain-'));
  const anvil = spawn(join(homedir(), '.foundry/bin/anvil'), ['--silent', '--host', '127.0.0.1', '--port', String(port),
    '--chain-id', '4663', '--hardfork', 'cancun', '--timestamp', String(Math.floor(Date.now()/1000)-86400)], { stdio: 'ignore' });
  // Standard public Anvil test mnemonic. Never uses a real wallet or environment signing key.
  const operator = mnemonicToAccount('test test test test test test test test test test test junk');
  const borrower = mnemonicToAccount('test test test test test test test test test test test junk', { addressIndex: 1 });
  const chain = { id: 4663, name: 'Cashback local test', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [`http://127.0.0.1:${port}`] } } };
  const transport = http(chain.rpcUrls.default.http[0], { retryCount: 0 });
  const client = createPublicClient({ chain, transport, cacheTime: 0, pollingInterval: 20 });
  const wallet = createWalletClient({ chain, transport });
  let ledger;
  let api;
  let runtime;
  const transactions = [];
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) {
      try { assert.equal(await client.getChainId(), 4663); ready = true; break; } catch {}
      if (anvil.exitCode !== null) throw new Error('Local Anvil exited before startup');
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.ok(ready, 'local chain starts');
    const mined = async hash => {
      const receipt = await client.waitForTransactionReceipt({ hash });
      assert.equal(receipt.status, 'success'); transactions.push(hash); return receipt;
    };
    const deploy = async (abi, args) => (await mined(await wallet.deployContract({ account: operator,
      abi: abi.abi, bytecode: abi.bytecode.object, args }))).contractAddress;
    const send = async (address, abi, functionName, args, account = operator) => mined(await wallet.writeContract({
      address, abi: abi.abi, functionName, args, account }));
    const read = (address, abi, functionName, args = []) => client.readContract({ address, abi: abi.abi, functionName, args });
    const setTime = timestamp => client.request({ method: 'evm_setNextBlockTimestamp', params: [timestamp] });
    const tokenABI = artifact(rewards, 'TurretBorrowerCashback.t.sol', 'CashbackUSDG');
    const engineABI = artifact(central, 'TurretCreditEngine.sol', 'TurretCreditEngine');
    const poolABI = artifact(central, 'TurretCapitalPool.sol', 'TurretCapitalPool');
    const campaignABI = artifact(rewards, 'TurretBorrowerCashback.sol', 'TurretBorrowerCashback');
    const routerABI = artifact(rewards, 'TurretRecoverableFeeRouter.sol', 'TurretRecoverableFeeRouter');
    const stakingABI = artifact(rewards, 'TurretRecoverableStaking.sol', 'TurretRecoverableStaking');
    const collateralABI = artifact(central, 'TurretCredit.t.sol', 'Token');
    const tokenTemplate = await deploy(tokenABI, []);
    const usdg = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';
    await client.request({method:'anvil_setCode',params:[usdg,await client.getCode({address:tokenTemplate})]});
    const collateral = await deploy(collateralABI, [18]);
    const turret = await deploy(collateralABI, [18]);
    const engine = await deploy(engineABI, [{ usdg, collateral, guardian: operator.address,
      maxLtvBps: 3000, liquidationLtvBps: 4000, bonusBps: 500, minimumDebt: 20_000_000n }, operator.address]);
    const pool = await deploy(poolABI, [usdg, collateral, engine, operator.address, 10000_000000n, 1000, 1000]);
    await send(engine, engineABI, 'bindPool', [pool]);
    await send(engine, engineABI, 'setRiskPaused', [false]);
    await send(usdg, tokenABI, 'mint', [operator.address, 1100_000000n]);
    await send(usdg, tokenABI, 'approve', [pool, maxUint256]);
    await send(pool, poolABI, 'deposit', [1000_000000n, operator.address]);
    const router = await deploy(routerABI, [turret, usdg, operator.address, [pool]]);
    await send(usdg, tokenABI, 'approve', [router, maxUint256]);
    const start = Number((await client.getBlock()).timestamp) + 100;
    const policy = { startsAt: start, endsAt: start + 10 * day, settlementDeadline: start + 40 * day,
      claimDeadline: start + 70 * day, rebateBps: 5000, engines: { [engine.toLowerCase()]: { aprBps: 1000 } } };
    const campaign = await deploy(campaignABI, [usdg, operator.address, operator.address,
      start, policy.endsAt, policy.settlementDeadline, policy.claimDeadline]);
    await send(usdg, tokenABI, 'approve', [campaign, maxUint256]);
    await send(campaign, campaignABI, 'fund', [100_000000n]);
    await send(campaign, campaignABI, 'enroll', [borrower.address, engine, 10_000000n]);
    await send(collateral, collateralABI, 'mint', [borrower.address, 20n * 10n ** 18n]);
    await send(usdg,tokenABI,'mint',[borrower.address,10_000000n]);
    let offset = 0;
    const clock = () => Math.floor(Date.now()/1000)+offset;
    await setTime(clock()); await client.request({method:'evm_mine',params:[]});
    const config = {chainId:4663,rewardToken:usdg,deployment:{address:campaign,runtimeHash:keccak256(await client.getCode({address:campaign}))}};
    const policyHash='0x'+'a'.repeat(64);
    const market={chainId:4663,accountingVersion:2,symbol:'AAPL',admission:'active',engine,pool,collateral,
      primary:operator.address,secondary:operator.address,owner:operator.address,
      hashes:{engine:keccak256(await client.getCode({address:engine})),pool:keccak256(await client.getCode({address:pool})),
        collateral:keccak256(await client.getCode({address:collateral})),usdg:keccak256(await client.getCode({address:usdg})),
        primary:policyHash,secondary:policyHash},central:{id:'AAPL',apiUrl:'https://cashback-e2e.invalid/',policyHash,weekend:false}};
    ledger=new CashbackLedger({path:join(directory,'ledger.sqlite'),policy,startBlock:1});
    const allocations=[];
    api=createRewardsServer({client,ledger,allocations,config:{chainId:4663,distributor:campaign,rewardToken:usdg,runtimeHash:config.deployment.runtimeHash,policy}});
    await new Promise(resolve=>api.listen(0,'127.0.0.1',resolve));
    const apiPort=api.address().port;
    const fixture={config,market,borrower:borrower.address,other:operator.address,rpc:chain.rpcUrls.default.http[0],policy};
    writeFileSync(join(root,'output/borrower-cashback-20260911/loan-fixture.json'),JSON.stringify(fixture,null,2)+'\n');
    let synchronizing;
    async function sync(){
      if(synchronizing)return synchronizing;
      synchronizing=(async()=>{const block=await client.getBlock();if(Number(block.timestamp)<clock()){
        await setTime(clock());await client.request({method:'evm_mine',params:[]});}
        await syncLedger({client,ledger,startBlock:1,campaign,engines:[engine],confirmations:0});
      })().finally(()=>{synchronizing=null;});
      return synchronizing;
    }
    await sync();
    const timer=setInterval(()=>void sync().catch(console.error),1000);
    let online=true;
    const control=createHTTPServer(async(req,res)=>{
      try{
        const url=new URL(req.url,'http://127.0.0.1');
        const json=body=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify(body,(_,v)=>typeof v==='bigint'?String(v):v));};
        if(url.pathname==='/fixture')return json({...fixture,now:clock()});
        if(url.pathname.startsWith('/api/borrower-cashback/')){
          if(!online){res.statusCode=503;return json({error:'test_outage'});}
          await sync();const response=await fetch(`http://127.0.0.1:${apiPort}${url.pathname.replace('/api/borrower-cashback','')}`);
          res.statusCode=response.status;res.setHeader('Content-Type','application/json');return res.end(await response.text());
        }
        if(url.pathname==='/central/v1/markets/AAPL')return json({market:'AAPL',policyHash,ready:true,code:'ready',prices:{at:clock(),
          liquidationPrice:String(100n*10n**18n),borrowPrice:String(100n*10n**18n),referenceUpdatedAt:clock()},
          availability:{paused:false,cash:String(await read(pool,poolABI,'availableCash')),principal:String(await read(pool,poolABI,'outstandingPrincipal')),debtLimit:'10000000000',minimumDebt:'20000000'}});
        if(url.pathname==='/central/v1/markets/AAPL/quote'&&req.method==='POST'){
          let raw='';for await(const part of req)raw+=part;if(raw.length>2000)throw Error('Test quote too large');const body=JSON.parse(raw);
          await sync();
          const observedAt=Math.min(clock(),Number((await client.getBlock()).timestamp));
          const message={borrower:body.borrower,action:body.action,collateralAmount:BigInt(body.collateralAmount),debtAmount:BigInt(body.debtAmount),
            maxDebt:1000_000000n,price:100n*10n**18n,nonce:await read(engine,engineABI,'approvalNonces',[body.borrower]),observedAt,deadline:observedAt+60,epoch:0n};
          const signature=await operator.sign({hash:await read(engine,engineABI,'approvalDigest',[message])});
          return json({primaryType:'Approval',policyHash,domain:{name:'TurretCreditEngine',version:'1',chainId:4663,verifyingContract:engine},
            message:{...message,observedAt:String(message.observedAt),deadline:String(message.deadline)},signature});
        }
        if(req.method==='POST'&&url.pathname.startsWith('/control/')){
          if(url.pathname==='/control/advance'){offset+=30*day;await sync();}
          else if(url.pathname==='/control/offline')online=false;
          else if(url.pathname==='/control/online')online=true;
          else if(url.pathname==='/control/publish'){
            await sync();const head=ledger.head();const allocation=buildAllocation({chainId:4663,distributor:campaign,accounts:ledger.accounts()});
            await send(campaign,campaignABI,'publish',[allocation.root,BigInt(head.number),head.hash]);allocations.push(allocation);await sync();
          }else{res.statusCode=404;return res.end();}return json({now:clock(),online});
        }
        if(url.pathname==='/evidence'){
          await sync();const events=await client.getLogs({address:engine,fromBlock:1n});const claims=await client.getLogs({address:campaign,fromBlock:1n});
          const result={localOnly:true,chainId:4663,engine,pool,campaign,borrower:borrower.address,policy,
            debt:String(await read(engine,engineABI,'positionDebt',[borrower.address])),collateralBalance:String(await read(collateral,collateralABI,'balanceOf',[borrower.address])),
            borrowerUSDG:String(await read(usdg,tokenABI,'balanceOf',[borrower.address])),claimed:String(await read(campaign,campaignABI,'claimed',[borrower.address,engine])),
            accounts:ledger.accounts(),engineTransactions:[...new Set(events.map(e=>e.transactionHash))],campaignTransactions:[...new Set(claims.map(e=>e.transactionHash))]};
          writeFileSync(join(root,'output/borrower-cashback-20260911/loan-browser-chain-evidence.json'),JSON.stringify(result,(_,v)=>typeof v==='bigint'?String(v):v,2)+'\n');return json(result);
        }
        res.statusCode=404;res.end();
      }catch(error){res.statusCode=500;res.end(error.message);}
    });
    await new Promise(resolve=>control.listen(4291,'127.0.0.1',resolve));
    console.log('Connected loan fixture ready: 127.0.0.1:4291 (disposable local chain 4663).');
    await new Promise(resolve=>{process.once('SIGTERM',resolve);process.once('SIGINT',resolve);});
    clearInterval(timer);if(synchronizing)await synchronizing;
    await new Promise(resolve=>control.close(resolve));
  }finally{
    if(api)await new Promise(resolve=>api.close(resolve));ledger?.close();anvil.kill('SIGTERM');
    await new Promise(resolve=>{if(anvil.exitCode!==null)resolve();else anvil.once('exit',resolve);});rmSync(directory,{recursive:true,force:true});
  }
}
run().catch(error=>{console.error(error);process.exitCode=1;});
