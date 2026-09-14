import {chmodSync,readFileSync,writeFileSync} from 'node:fs';
import {createPublicClient,formatEther,formatUnits,getAddress,http,keccak256,parseAbi} from 'viem';
import {privateKeyToAccount} from 'viem/accounts';
import {BEACON_SLOT,IMPLEMENTATION_SLOT,parseDependencyPins,verifyDependencyPins} from '../../services/liquidator/src/isolated/dependencies.mjs';

const need=(value,message)=>{if(!value)throw Error(message);return value;};
const same=(a,b)=>a.toLowerCase()===b.toLowerCase();
const read=path=>JSON.parse(readFileSync(path,'utf8'));
const plan=read(process.env.STOCK_EXPANSION_PLAN??'/tmp/dockyard-stock-expansion-plan.json');
const progress=read(process.env.STOCK_EXPANSION_PROGRESS??new URL('../../docs/security/evidence/2026-09-03/market-expansion-live-progress.json',import.meta.url));
const secrets=read(need(process.env.STOCK_EXPANSION_SECRETS,'STOCK_EXPANSION_SECRETS is required'));
const keeperTemplate=read(need(process.env.STOCK_KEEPER_VARIABLES,'STOCK_KEEPER_VARIABLES is required'));
const riskTemplate=read(need(process.env.STOCK_RISK_VARIABLES,'STOCK_RISK_VARIABLES is required'));
const alertsTemplate=read(need(process.env.STOCK_ALERTS_VARIABLES,'STOCK_ALERTS_VARIABLES is required'));
const output=process.env.STOCK_EXPANSION_RAILWAY_OUTPUT??'/tmp/dockyard-stock-expansion-railway.json';
const rpc=keeperTemplate.ALCHEMY_RPC_URL??keeperTemplate.KEEPER_RPC_URL;
const client=createPublicClient({transport:http(need(rpc,'RPC is required'),{timeout:20_000,retryCount:1}),cacheTime:0});
need(await client.getChainId()===4663,'Wrong chain');
const head=await client.getBlock();
need(BigInt(Math.floor(Date.now()/1000))-head.timestamp<60n,'Stale RPC head');

const common={
 owner:plan.owner,usdg:plan.shared.usdg,usdgPrimary:plan.shared.usdgPrimary,usdgSecondary:plan.shared.usdgSecondary,
 usdgCodeHash:keeperTemplate.STOCK_USDG_CODE_HASH,usdgPrimaryCodeHash:keeperTemplate.STOCK_USDG_PRIMARY_CODE_HASH,
 usdgSecondaryCodeHash:keeperTemplate.STOCK_USDG_SECONDARY_CODE_HASH,
};
const hashAt=async address=>keccak256(need(await client.getCode({address,blockNumber:head.number}),`Missing code ${address}`));
const storageAddress=async(address,slot)=>{
 const word=need(await client.getStorageAt({address,slot,blockNumber:head.number}),`Missing storage ${address}`);
 return getAddress(`0x${word.slice(-40)}`);
};
const implementationAbi=parseAbi(['function implementation() view returns(address)']);
const aggregatorAbi=parseAbi(['function aggregator() view returns(address)']);
const beaconPin=async address=>{
 const beacon=await storageAddress(address,BEACON_SLOT),implementation=await client.readContract({address:beacon,abi:implementationAbi,functionName:'implementation',blockNumber:head.number});
 return {address,kind:'beacon',beacon,beaconCodeHash:await hashAt(beacon),implementation,implementationCodeHash:await hashAt(implementation)};
};
const implementationPin=async address=>{const implementation=await storageAddress(address,IMPLEMENTATION_SLOT);return {address,kind:'implementation',implementation,implementationCodeHash:await hashAt(implementation)};};
const aggregatorPin=async address=>{const implementation=await client.readContract({address,abi:aggregatorAbi,functionName:'aggregator',blockNumber:head.number});return {address,kind:'aggregator',implementation,implementationCodeHash:await hashAt(implementation)};};
const [usdgPin,usdgOraclePin]=await Promise.all([implementationPin(common.usdg),aggregatorPin(common.usdgPrimary)]);
const balanceAbi=[{type:'function',name:'balanceOf',stateMutability:'view',inputs:[{name:'',type:'address'}],outputs:[{name:'',type:'uint256'}]}];
const services={};
for(const market of plan.markets){
 const deployed=need(progress.markets.find(x=>x.symbol===market.symbol),`Missing deployment ${market.symbol}`);
 need(deployed.paused&&deployed.empty,'Market must remain paused and empty');
 const keyPair=need(secrets[market.symbol],`Missing signers ${market.symbol}`);
 need(same(privateKeyToAccount(keyPair.guardian).address,deployed.roles.guardian),'Guardian key mismatch');
 need(same(privateKeyToAccount(keyPair.keeper).address,deployed.roles.keeper),'Keeper key mismatch');
 const [engineCodeHash,poolCodeHash,bundleCodeHash,exitCodeHash,collateralCodeHash,primaryCodeHash,guardianEth,keeperEth,keeperUsdg]=await Promise.all([
  hashAt(deployed.addresses.engine),hashAt(deployed.addresses.pool),hashAt(deployed.addresses.bundle),hashAt(deployed.addresses.exit),hashAt(market.input.credit.collateral),hashAt(market.input.credit.primary),
  client.getBalance({address:deployed.roles.guardian,blockNumber:head.number}),client.getBalance({address:deployed.roles.keeper,blockNumber:head.number}),
  client.readContract({address:common.usdg,abi:balanceAbi,functionName:'balanceOf',args:[deployed.roles.keeper],blockNumber:head.number}),
 ]);
 need(same(bundleCodeHash,deployed.runtimeHashes[2]),`Bundle runtime mismatch ${market.symbol}`);
 need(same(exitCodeHash,deployed.runtimeHashes[3]),`Exit runtime mismatch ${market.symbol}`);
 const [collateralPin,stockOraclePin]=await Promise.all([beaconPin(market.input.credit.collateral),aggregatorPin(market.input.credit.primary)]);
 const pins=[collateralPin,usdgPin,stockOraclePin,usdgOraclePin];
 const parsed=parseDependencyPins(JSON.stringify(pins),{collateral:market.input.credit.collateral,usdg:common.usdg,primary:market.input.credit.primary,usdgPrimary:common.usdgPrimary},{required:true});
 await verifyDependencyPins(client,parsed,head.number);
 const base=`https://dockyard-${market.symbol.toLowerCase()}`;
 const riskUrl=`${base}-risk-production.up.railway.app`,keeperUrl=`${base}-keeper-production.up.railway.app`,alertsUrl=`${base}-alerts-production.up.railway.app`;
 const statusToken=crypto.randomUUID().replaceAll('-','')+crypto.randomUUID().replaceAll('-','');
 const riskStatusToken=crypto.randomUUID().replaceAll('-','')+crypto.randomUUID().replaceAll('-','');
 const manifest={kind:'stock-pool',chainId:4663,status:'receipt-verified',marketDataVerified:true,revision:'stock-expansion-sip-pinned-v1',
  vault:deployed.addresses.engine,vaultCodeHash:engineCodeHash,pool:deployed.addresses.pool,poolCodeHash,
  usdg:common.usdg,usdgCodeHash:common.usdgCodeHash,executionGate:deployed.addresses.gate,executionGateCodeHash:deployed.runtimeHashes[1],
  usdgPrimary:common.usdgPrimary,usdgPrimaryCodeHash:common.usdgPrimaryCodeHash,usdgSecondary:common.usdgSecondary,usdgSecondaryCodeHash:common.usdgSecondaryCodeHash,
  owner:common.owner,guardian:deployed.roles.guardian,keeper:deployed.roles.keeper,startBlock:deployed.blockNumber,
  markets:[{symbol:market.symbol,collateral:market.input.credit.collateral,collateralCodeHash,primaryOracle:market.input.credit.primary,primaryCodeHash,
   adapter:deployed.addresses.guard,adapterCodeHash:deployed.runtimeHashes[0],maxPriceAgeSeconds:86400,sessionDataVerified:{regular:'sip'}}],
  tradingSessionPolicy:'regular',dependencies:pins};
 const pick=(source,names)=>Object.fromEntries(names.filter(x=>source[x]).map(x=>[x,source[x]]));
 services[market.symbol]={urls:{risk:riskUrl,keeper:keeperUrl,alerts:alertsUrl},manifest,
  risk:{NODE_ENV:'production',PORT:'8080',...pick(riskTemplate,['ALCHEMY_RPC_URL','KEEPER_FALLBACK_RPC_URLS','ALPACA_API_KEY','ALPACA_API_SECRET','ALPACA_DATA_FEED','RESEND_API_KEY','RISK_ALERT_EMAIL_FROM','RISK_ALERT_EMAIL_TO','KEEPER_ALERT_REMINDER_MS']),
   RISK_MANIFEST_JSON:JSON.stringify(manifest),RISK_APP_ORIGIN:'https://turret.capital',RISK_DATA_DIR:'/data',RISK_MODE:'execute',RISK_LIVENESS_MODE:'execute',RISK_LIVENESS_URL:`${riskUrl}/liveness`,
   RISK_STATUS_TOKEN:riskStatusToken,RISK_KEEPER_STATUS_TOKEN:statusToken,RISK_KEEPER_STATUS_URL:`${keeperUrl}/status`,RISK_GUARDIAN_PRIVATE_KEY:keyPair.guardian,KEEPER_POLL_MS:'5000'},
  keeper:{NODE_ENV:'production',PORT:'8080',...pick(keeperTemplate,['ALCHEMY_RPC_URL','KEEPER_FALLBACK_RPC_URLS','RESEND_API_KEY','KEEPER_ALERT_EMAIL_FROM','KEEPER_ALERT_EMAIL_TO','KEEPER_ALERT_REMINDER_MS','KEEPER_ALERT_DEBOUNCE_MS']),
   KEEPER_PRIVATE_KEY:keyPair.keeper,KEEPER_MODE:'execute',KEEPER_DATA_DIR:'/data',KEEPER_STATUS_TOKEN:statusToken,KEEPER_CONFIRMATIONS:'12',KEEPER_NATIVE_WATCHDOG:'false',KEEPER_POLL_MS:'5000',
   KEEPER_ALERT_LABEL:`${market.symbol} keeper`,KEEPER_ALERT_DEBOUNCE_MS:keeperTemplate.KEEPER_ALERT_DEBOUNCE_MS??'30000',
   KEEPER_MAX_REPAY_USDG:'10',KEEPER_DAILY_BUDGET_USDG:'30',KEEPER_INVENTORY_BUDGET_USDG:'30',KEEPER_MIN_USDG:'11',KEEPER_MIN_ETH:'0.001',KEEPER_MAX_TX_FEE_ETH:'0.0005',KEEPER_DAILY_GAS_ETH:'0.003',
   ISOLATED_MARKET_KIND:'stock',ISOLATED_ENGINE_ADDRESS:deployed.addresses.engine,ISOLATED_ENGINE_CODE_HASH:engineCodeHash,ISOLATED_POOL_ADDRESS:deployed.addresses.pool,ISOLATED_POOL_CODE_HASH:poolCodeHash,
   ISOLATED_COLLATERAL_ADDRESS:market.input.credit.collateral,ISOLATED_COLLATERAL_CODE_HASH:collateralCodeHash,ISOLATED_PRIMARY_ORACLE:market.input.credit.primary,ISOLATED_PRIMARY_CODE_HASH:primaryCodeHash,
   ISOLATED_SECONDARY_ORACLE:deployed.addresses.guard,ISOLATED_SECONDARY_CODE_HASH:deployed.runtimeHashes[0],ISOLATED_EXIT_ADDRESS:deployed.addresses.exit,ISOLATED_EXIT_CODE_HASH:exitCodeHash,
   ISOLATED_ALLOW_RETAINED_COLLATERAL:'false',ISOLATED_MIN_PROFIT_USDG:'0.000001',ISOLATED_MIN_PROFIT_BPS:'50',KEEPER_EXECUTION_GATE:deployed.addresses.gate,
   KEEPER_LIVENESS_URL:`${riskUrl}/liveness`,STOCK_EXECUTION_GATE_CODE_HASH:deployed.runtimeHashes[1],STOCK_GUARDIAN_ADDRESS:deployed.roles.guardian,
   STOCK_USDG_CODE_HASH:common.usdgCodeHash,STOCK_USDG_PRIMARY_ORACLE:common.usdgPrimary,STOCK_USDG_PRIMARY_CODE_HASH:common.usdgPrimaryCodeHash,
   STOCK_USDG_SECONDARY_ORACLE:common.usdgSecondary,STOCK_USDG_SECONDARY_CODE_HASH:common.usdgSecondaryCodeHash,STOCK_DEPENDENCIES_JSON:JSON.stringify(pins)},
  alerts:{NODE_ENV:'production',PORT:'3030',...pick(alertsTemplate,['RESEND_API_KEY','ALERTS_EMAIL_FROM']),ALERTS_APP_ORIGIN:'https://turret.capital',ALERTS_RPC_URL:rpc,
   ALERTS_DATA_KEY:crypto.randomUUID().replaceAll('-','')+crypto.randomUUID().replaceAll('-',''),ALERTS_DB_PATH:'/data/alerts.sqlite',ALERTS_PROTOCOL:'isolated',ALERTS_ISOLATED_MARKET_KIND:'stock',
   ALERTS_VAULT_ADDRESS:deployed.addresses.engine,ALERTS_VAULT_CODE_HASH:engineCodeHash,ALERTS_POOL_ADDRESS:deployed.addresses.pool,ALERTS_POOL_CODE_HASH:poolCodeHash,
   ALERTS_COLLATERAL_ADDRESS:market.input.credit.collateral,ALERTS_COLLATERAL_CODE_HASH:collateralCodeHash,ALERTS_START_BLOCK:deployed.blockNumber,
   ALERTS_EXECUTION_GATE:deployed.addresses.gate,ALERTS_EXECUTION_GATE_CODE_HASH:deployed.runtimeHashes[1],ALERTS_LIVENESS_URL:`${riskUrl}/liveness`},
  funding:{guardianEth:formatEther(guardianEth),keeperEth:formatEther(keeperEth),keeperUsdg:formatUnits(keeperUsdg,6)},
 };
}
writeFileSync(output,JSON.stringify({version:1,preparedAt:new Date().toISOString(),blockNumber:String(head.number),services},null,2),{mode:0o600});chmodSync(output,0o600);
console.log(JSON.stringify({output,blockNumber:String(head.number),markets:Object.fromEntries(Object.entries(services).map(([symbol,x])=>[symbol,x.funding]))},null,2));
