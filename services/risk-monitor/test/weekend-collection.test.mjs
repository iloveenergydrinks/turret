import test from 'node:test';
import assert from 'node:assert/strict';
import {agreedWeekendHead,collectWeekendObservation} from '../src/weekend-collection.mjs';

const at=1788624000,head={number:10n,timestamp:BigInt(at),hash:'0xabc'};
const client=(overrides={})=>({getChainId:async()=>4663,getBlock:async()=>head,...overrides});
const manifest={vault:'0x1234',tradingSessionPolicy:'equities-24x5'};
const kraken=async()=>({fresh:true,midUsd:100,tradeAgeSeconds:1,latestTradeAt:at-1,maxTradeAgeSeconds:120,bids:[{price:99}],asks:[{price:101}],receivedAt:at*1000});
const onchain=async()=>({block:'10',blockers:[],pool:{spotPriceUsdPerTokenE18:'200000000000000000000'},token:{multiplier:'2000000000000000000'}});

test('two independent provider views must agree at the same pinned block',async()=>{
 assert.equal(await agreedWeekendHead([client(),client()],at),head);
 await assert.rejects(agreedWeekendHead([],at),/WeekendProviderRequired/);
 await assert.rejects(agreedWeekendHead([client(),client({getChainId:async()=>1})],at),/WeekendWrongChain/);
 await assert.rejects(agreedWeekendHead([client(),client({getBlock:async()=>({...head,hash:'0xbad'})})],at),/WeekendProviderDisagreement/);
 await assert.rejects(agreedWeekendHead([client(),client({getBlock:async()=>({...head,timestamp:head.timestamp-1n})})],at),/WeekendProviderDisagreement/);
 assert.equal(await agreedWeekendHead([client(),client()],at+30),head);
 await assert.rejects(agreedWeekendHead([client(),client()],at+31),/WeekendBlockStale/);
 await assert.rejects(agreedWeekendHead([client(),client()],at-1),/WeekendBlockStale/);
});

test('moderate head skew and the 40-block boundary use the exact lower common block',async()=>{
 for(const lag of [4n,40n])for(const leadingProvider of [0,1]){
  const pinned=[];
  const clients=[0,1].map(index=>client({getBlock:async(options)=>{
   if(options){pinned.push(options.blockNumber);return head;}
   return {...head,number:head.number+(index===leadingProvider?lag:0n)};
  }}));
  assert.equal(await agreedWeekendHead(clients,at),head);
  assert.deepEqual(pinned,[head.number,head.number]);
 }
});

test('head skew over 40 blocks is rejected before collecting the common block',async()=>{
 let pinnedReads=0;
 const clients=[0n,41n].map(lag=>client({getBlock:async(options)=>{
  if(options){pinnedReads++;return head;}
  return {...head,number:head.number+lag};
 }}));
 await assert.rejects(agreedWeekendHead(clients,at),/WeekendProviderLag/);
 assert.equal(pinnedReads,0);
});

test('each provider must return the requested pinned block number',async()=>{
 for(const invalidNumber of [undefined,head.number+1n])for(const invalidProvider of [0,1]){
  const clients=[0,1].map(index=>client({getBlock:async(options)=>
   options&&index===invalidProvider?{...head,number:invalidNumber}:head}));
  await assert.rejects(agreedWeekendHead(clients,at),/WeekendProviderDisagreement/);
 }
});

test('latest-head probes start without waiting for chain-ID responses',async()=>{
 const starts=[];let finishChainIds;
 const chainIds=new Promise(resolve=>{finishChainIds=resolve;});
 const clients=[0,1].map(index=>client({
  getChainId:()=>{starts.push(`chain:${index}`);return chainIds;},
  getBlock:async(options)=>{starts.push(`${options?'pinned':'latest'}:${index}`);return head;},
 }));
 const pending=agreedWeekendHead(clients,at);
 try{assert.deepEqual(starts,['chain:0','latest:0','chain:1','latest:1']);}
 finally{finishChainIds(4663);}
 assert.equal(await pending,head);
});

test('single-provider observations explicitly carry the missing corroboration blocker',async()=>{
 const sample=await collectWeekendObservation({clients:[client()],manifest,now:()=>at,kraken,onchain});
 assert.equal(sample.observationComplete,true);
 assert.equal(sample.sources.onchain.corroborated,false);
 assert.ok(sample.blockers.includes('IndependentRpcCorroborationUnavailable'));
});

test('complete sample remains observation-only and cross-issuer comparison stays indicative',async()=>{
 const sample=await collectWeekendObservation({clients:[client(),client()],manifest,now:()=>at,kraken,onchain});
 assert.equal(sample.observationComplete,true);assert.equal(sample.borrowingEligible,false);
 assert.equal(sample.sources.onchain.available,true);assert.equal(sample.sources.onchain.corroborated,true);
 assert.equal(sample.session.open,false);
 assert.equal(sample.comparison.robinhoodUsdPerShareEquivalent,100);
 assert.equal(sample.comparison.indicativeDifferenceBps,0);
 assert.equal(sample.comparison.forAdmission,false);assert.equal(sample.comparison.unitBasisVerified,false);
 assert.equal(sample.kraken.bids,undefined);assert.equal(sample.kraken.asks,undefined);
});

test('one failed source does not discard the other or leak RPC secrets',async()=>{
 const sample=await collectWeekendObservation({clients:[client(),client()],manifest,now:()=>at,kraken,
  onchain:async()=>{throw new Error('secret=https://rpc.example/private-key');}});
 assert.equal(sample.observationComplete,false);assert.equal(sample.sources.kraken.available,true);
 assert.equal(sample.sources.onchain.available,false);assert.equal(sample.sources.onchain.corroborated,false);
 assert.equal(sample.comparison.available,false);
 assert.doesNotMatch(JSON.stringify(sample),/private-key/);
 assert.ok(sample.blockers.includes('ObservationSourceUnavailable'));
});

test('failed provider agreement cannot claim onchain corroboration',async()=>{
 const sample=await collectWeekendObservation({clients:[client(),client({getBlock:async()=>({...head,hash:'0xbad'})})],
  manifest,now:()=>at,kraken,onchain:async()=>assert.fail('onchain collection must wait for provider agreement')});
 assert.equal(sample.observationComplete,false);assert.equal(sample.sources.kraken.available,true);
 assert.equal(sample.sources.onchain.available,false);assert.equal(sample.sources.onchain.corroborated,false);
 assert.ok(sample.blockers.includes('WeekendProviderDisagreement'));
});

test('stale but valid observations preserve evidence and carry blockers',async()=>{
 const sample=await collectWeekendObservation({clients:[client(),client()],manifest,now:()=>at,onchain,
  kraken:async()=>({...await kraken(),fresh:false,reason:'KrakenStaleTrade',tradeAgeSeconds:300})});
 assert.equal(sample.observationComplete,true);assert.equal(sample.sources.kraken.fresh,false);
 assert.ok(sample.blockers.includes('KrakenStaleTrade'));assert.equal(sample.borrowingEligible,false);
});
