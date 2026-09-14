import {getAddress,keccak256,parseAbi,stringToHex,toHex,zeroAddress} from 'viem';

const slot = label => toHex(BigInt(keccak256(stringToHex(label)))-1n,{size:32});
export const IMPLEMENTATION_SLOT=slot('eip1967.proxy.implementation');
export const BEACON_SLOT=slot('eip1967.proxy.beacon');
const implementationAbi=parseAbi(['function implementation() view returns(address)']);
const aggregatorAbi=parseAbi(['function aggregator() view returns(address)']);
const same=(a,b)=>typeof a==='string'&&typeof b==='string'&&a.toLowerCase()===b.toLowerCase();
const hash=x=>/^0x[0-9a-fA-F]{64}$/.test(x??'');
const address=x=>{const a=getAddress(x);if(a===zeroAddress)throw new Error('InvalidStockDependencyPins');return a;};

export function parseDependencyPins(encoded,targets,{required=false}={}){
 if(!encoded){if(required)throw new Error('StockDependencyPinsRequired');return [];}
 let pins;try{pins=JSON.parse(encoded);}catch{throw new Error('InvalidStockDependencyPins');}
 if(!Array.isArray(pins)||pins.length!==4)throw new Error('InvalidStockDependencyPins');
 const expected=new Map([[targets.collateral,'token'],[targets.usdg,'token'],[targets.primary,'oracle'],[targets.usdgPrimary,'oracle']].map(([a,k])=>[a.toLowerCase(),k]));
 const seen=new Set();
 return pins.map(p=>{
  const target=address(p.address),category=expected.get(target.toLowerCase());
  if(!category||seen.has(target.toLowerCase())||!hash(p.implementationCodeHash)
   ||(category==='oracle'?p.kind!=='aggregator':!['implementation','beacon'].includes(p.kind)))throw new Error('InvalidStockDependencyPins');
  seen.add(target.toLowerCase());
  const result={address:target,kind:p.kind,implementation:address(p.implementation),implementationCodeHash:p.implementationCodeHash.toLowerCase()};
  if(p.kind==='beacon'){
   if(!hash(p.beaconCodeHash))throw new Error('InvalidStockDependencyPins');
   result.beacon=address(p.beacon);result.beaconCodeHash=p.beaconCodeHash.toLowerCase();
  }
  return result;
 });
}

export async function verifyDependencyPins(client,pins,blockNumber){
 const changed=()=>{const e=new Error('Stock dependency implementation changed');e.name='StockDependencyChanged';return e;};
 const storageAddress=async(target,key)=>{
  const value=await client.getStorageAt({address:target,slot:key,blockNumber});
  if(!/^0x0{24}[0-9a-fA-F]{40}$/.test(value??''))throw changed();
  return '0x'+value.slice(-40);
 };
 await Promise.all(pins.map(async p=>{
  let implementation;
  if(p.kind==='aggregator')implementation=await client.readContract({address:p.address,abi:aggregatorAbi,functionName:'aggregator',blockNumber});
  else if(p.kind==='implementation')implementation=await storageAddress(p.address,IMPLEMENTATION_SLOT);
  else {
   const beacon=await storageAddress(p.address,BEACON_SLOT);
   if(!same(beacon,p.beacon))throw changed();
   const [code,resolved]=await Promise.all([
    client.getCode({address:beacon,blockNumber}),
    client.readContract({address:beacon,abi:implementationAbi,functionName:'implementation',blockNumber}),
   ]);
   if(!code||!same(keccak256(code),p.beaconCodeHash))throw changed();
   implementation=resolved;
  }
  if(!same(implementation,p.implementation))throw changed();
  const code=await client.getCode({address:implementation,blockNumber});
  if(!code||code==='0x'||!same(keccak256(code),p.implementationCodeHash))throw changed();
 }));
 return true;
}
