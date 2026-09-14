import { keccak256, parseAbi } from "viem";
import { validateTokenBaseline, inspectTokenBaseline } from "../p2p/health-core.mjs";
import { facilityReadAbi, validateFacilityEntry } from "./reader.mjs";
import { isAccount, same, uint } from "./quotes.mjs";

export const factoryAbi = parseAbi([
  "function loanToken() view returns(address)",
  "function collateralAllowed(address) view returns(bool)",
  "function getFacility(address lender,address collateral) view returns(address)",
  "function createdAtBlock(address) view returns(uint256)",
  "function facilityCount() view returns(uint256)",
  "function facilities(uint256) view returns(address)",
  "function createFacility(address collateral,(uint256 maxExposure,uint256 minDraw,uint256 maxDraw,uint256 minDuration,uint256 maxDuration,uint256 maxQuoteLifetime,uint256 minCollateralPerPrincipalWad,uint256 minInterestBps) limits) returns(address)",
  "event FacilityCreated(address indexed lender,address indexed collateral,address indexed facility)",
]);
const hash = value => typeof value === "string" && /^0x[0-9a-f]{64}$/i.test(value);
export function validateFactoryConfig(config) {
  if (!config || config.schemaVersion !== 1 || ![4663,31337].includes(config.chainId)
    || !isAccount(config.factory) || !hash(config.runtimeHash) || !isAccount(config.loanToken)
    || !Array.isArray(config.collateral) || !config.collateral.length || config.collateral.length > 100
    || uint(config.startBlock) < 0n) throw new Error("Standing offer configuration is unavailable.");
  validateTokenBaseline(config.baseline, config.chainId);
  const cash=config.baseline.tokens.find(t=>same(t.address,config.loanToken));
  if (!cash || cash.decimals!==6) throw new Error("USDG identity is unavailable.");
  const seen=new Set();
  for(const token of config.collateral) {
    const baseline=config.baseline.tokens.find(t=>same(t.address,token.address));
    if(!isAccount(token.address)||same(token.address,config.loanToken)||seen.has(token.address.toLowerCase())
      || !/^[A-Z0-9]{1,12}$/.test(token.symbol)||typeof token.name!=="string"||token.name.length>100
      || !baseline || baseline.decimals!==token.decimals) throw new Error("Unsupported standing collateral.");
    seen.add(token.address.toLowerCase());
  }
  return config;
}
export async function verifyFactory(client,config,{block,clock=Date.now}={}) {
  validateFactoryConfig(config);
  if(await client.getChainId()!==config.chainId)throw new Error("Standing offer network mismatch.");
  block??=await client.getBlock();
  if(typeof block.number!=="bigint"||!hash(block.hash)||typeof block.timestamp!=="bigint"
    || block.number<uint(config.startBlock)||Math.abs(clock()-Number(block.timestamp)*1000)>=30000)throw new Error("Standing offer checks need a fresh block.");
  const [code,cash]=await Promise.all([client.getCode({address:config.factory,blockNumber:block.number}),client.readContract({address:config.factory,abi:factoryAbi,functionName:"loanToken",blockNumber:block.number})]);
  if(!code||!same(keccak256(code),config.runtimeHash)||!same(cash,config.loanToken))throw new Error("Standing offer factory identity changed.");
  return block;
}
/** Derive a deployment identity only from the pinned immutable factory's own registry.
 * User-supplied runtime hashes, lenders, fees and start blocks are never accepted.
 */
export async function readFactoryFacility(client,config,address,{clock=Date.now,qualify=true}={}) {
  if(!isAccount(address))throw new Error("Invalid lending balance address.");
  const block=await verifyFactory(client,config,{clock});
  const read=(target,abi,name,args=[])=>client.readContract({address:target,abi,functionName:name,args,blockNumber:block.number});
  const names=["lender","loanToken","collateralToken","feeRecipient","feeBps","vaultImplementation"];
  const values=await Promise.all(names.map(n=>read(address,facilityReadAbi,n)));
  const state=Object.fromEntries(names.map((n,i)=>[n,values[i]]));
  const token=config.collateral.find(t=>same(t.address,state.collateralToken));
  if(!token || !same(state.loanToken,config.loanToken)||!isAccount(state.lender)||!same(state.feeRecipient,state.lender)||state.feeBps!==0n)throw new Error("Unrecognized lending balance.");
  const [registered,startBlock,allowed,code,vaultCode,manager,vaultCash,vaultToken]=await Promise.all([
    read(config.factory,factoryAbi,"getFacility",[state.lender,state.collateralToken]),
    read(config.factory,factoryAbi,"createdAtBlock",[address]),read(config.factory,factoryAbi,"collateralAllowed",[state.collateralToken]),
    client.getCode({address,blockNumber:block.number}),client.getCode({address:state.vaultImplementation,blockNumber:block.number}),
    ...["manager","loanToken","collateralToken"].map(n=>read(state.vaultImplementation,facilityReadAbi,n))
  ]);
  if(!same(registered,address)||startBlock<uint(config.startBlock)||startBlock>block.number||!allowed||!code||code==="0x"||!vaultCode||vaultCode==="0x"
    ||!same(manager,address)||!same(vaultCash,config.loanToken)||!same(vaultToken,token.address))throw new Error("This lending balance was not created by the verified factory.");
  if(qualify)for(const a of [config.loanToken,token.address]) {
    const reason=await inspectTokenBaseline(client,config.baseline.tokens.find(t=>same(t.address,a)),block);
    if(reason)throw new Error(reason);
  }
  const entry={chainId:config.chainId,address:address.toLowerCase(),lender:state.lender,loanToken:config.loanToken,collateralToken:token.address,
    collateralSymbol:token.symbol,collateralDecimals:token.decimals,loanDecimals:6,feeRecipient:state.feeRecipient,feeBps:"0",vaultImplementation:state.vaultImplementation,
    runtimeHash:keccak256(code),vaultImplementationHash:keccak256(vaultCode),startBlock:String(startBlock),factory:config.factory};
  validateFacilityEntry(entry,config.baseline);
  const creation=await client.getBlock({blockNumber:startBlock});
  if(!hash(creation.hash)||!same((await client.getBlock({blockNumber:block.number})).hash,block.hash)
    ||Math.abs(clock()-Number(block.timestamp)*1000)>=30000)throw new Error("Chain changed during lending balance verification.");
  return {entry,creationHash:creation.hash,checkedAt:clock()};
}
