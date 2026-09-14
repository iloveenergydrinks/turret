import test from 'node:test';
import assert from 'node:assert/strict';
import {keccak256} from 'viem';
import {parseDependencyPins,verifyDependencyPins,IMPLEMENTATION_SLOT,BEACON_SLOT} from '../src/isolated/dependencies.mjs';

const addr=n=>'0x'+n.toString(16).padStart(40,'0'),hash=keccak256('0x1234');
const targets={collateral:addr(1),usdg:addr(2),primary:addr(3),usdgPrimary:addr(4)};
const fixture=()=>[
 {address:addr(1),kind:'beacon',beacon:addr(5),beaconCodeHash:hash,implementation:addr(11),implementationCodeHash:hash},
 {address:addr(2),kind:'implementation',implementation:addr(12),implementationCodeHash:hash},
 {address:addr(3),kind:'aggregator',implementation:addr(13),implementationCodeHash:hash},
 {address:addr(4),kind:'aggregator',implementation:addr(14),implementationCodeHash:hash},
];
function harness(){
 const pins=parseDependencyPins(JSON.stringify(fixture()),targets,{required:true});
 const slots=new Map([[addr(1)+BEACON_SLOT,addr(5)],[addr(2)+IMPLEMENTATION_SLOT,addr(12)]]);
 const implementations=new Map([[addr(5),addr(11)],[addr(3),addr(13)],[addr(4),addr(14)]]);
 const codes=new Map();
 const client={
  getStorageAt:async({address,slot,blockNumber})=>{assert.equal(blockNumber,123n);return '0x'+'0'.repeat(24)+slots.get(address.toLowerCase()+slot).slice(2);},
  readContract:async({address,blockNumber})=>{assert.equal(blockNumber,123n);return implementations.get(address.toLowerCase());},
  getCode:async({address,blockNumber})=>{assert.equal(blockNumber,123n);return codes.get(address.toLowerCase())??'0x1234';},
 };
 return {pins,slots,implementations,codes,client};
}

test('pins cover exactly both tokens and both external oracle proxies',()=>{
 assert.equal(parseDependencyPins(JSON.stringify(fixture()),targets,{required:true}).length,4);
 assert.throws(()=>parseDependencyPins(undefined,targets,{required:true}),/Required/);
 assert.deepEqual(parseDependencyPins(undefined,targets),[]);
 for(const mutate of [p=>p.pop(),p=>p.push(p[0]),p=>{p[1].address=p[0].address;},p=>{p[0].address=addr(90);},
  p=>{p[0].kind='aggregator';},p=>{p[2].kind='beacon';},p=>{delete p[0].beaconCodeHash;},p=>{p[1].implementation=addr(0);}]){
  const p=fixture();mutate(p);assert.throws(()=>parseDependencyPins(JSON.stringify(p),targets,{required:true}));
 }
});
test('unchanged implementations verify at one pinned block',async()=>{
 const h=harness();assert.equal(await verifyDependencyPins(h.client,h.pins,123n),true);
});
for(const [name,mutate] of [
 ['ERC-1967 implementation pointer',h=>h.slots.set(addr(2)+IMPLEMENTATION_SLOT,addr(90))],
 ['beacon pointer',h=>h.slots.set(addr(1)+BEACON_SLOT,addr(90))],
 ['beacon implementation',h=>h.implementations.set(addr(5),addr(90))],
 ['aggregator pointer',h=>h.implementations.set(addr(3),addr(90))],
 ['implementation bytecode',h=>h.codes.set(addr(12),'0x00')],
 ['beacon bytecode',h=>h.codes.set(addr(5),'0x00')],
])test(`unchanged proxy bytecode cannot hide changed ${name}`,async()=>{
 const h=harness();mutate(h);await assert.rejects(verifyDependencyPins(h.client,h.pins,123n),{name:'StockDependencyChanged'});
});
test('unreadable storage fails closed rather than assuming the recorded implementation',async()=>{
 const h=harness();h.client.getStorageAt=async()=>undefined;
 await assert.rejects(verifyDependencyPins(h.client,h.pins,123n),{name:'StockDependencyChanged'});
});
