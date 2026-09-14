import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {decodeEnvelope,parseEnvelope,requestPrices,priceIssues} from '../src/pyth.mjs';
const fixture=JSON.parse(readFileSync(new URL('../../../contracts/utils/assets/oracle-fixtures/pyth-signed-sample.json',import.meta.url)));
const signed=fixture.sample.signed;
const evm={encoding:'base64',data:Buffer.from(signed.slice(2),'hex').toString('base64')};
test('decodes actual signed Pyth report including optional source timestamp',()=>{
 const parsed=parseEnvelope(decodeEnvelope(evm));assert.equal(parsed.timestampUs,BigInt(fixture.sample.timestampUs));
 assert.equal(parsed.feeds[0].sourceUs,parsed.timestampUs);assert.equal(parsed.feeds[0].price,BigInt(fixture.sample.feeds[0].price));
});
test('never trusts unsigned parsed JSON over signed fields',async()=>{
 const result=await requestPrices('unit-test-key',[1],async()=>({ok:true,status:200,json:async()=>({evm,parsed:{timestampUs:'0',priceFeeds:[{price:'1'}]}})}));
 assert.equal(result.feeds[0].price,BigInt(fixture.sample.feeds[0].price));
});
test('rejects missing or substituted feed identity',async()=>{
 await assert.rejects(requestPrices('unit-test-key',[922],async()=>({ok:true,status:200,json:async()=>({evm})})),{name:'PythFeedMismatch'});
});
test('entitlement and rate limit errors never include response bodies or API keys',async()=>{
 for(const [status,name] of [[403,'PythEntitlementDenied'],[429,'PythRateLimited']])await assert.rejects(requestPrices('unit-test-key',[1],async()=>({ok:false,status,text:async()=>{throw Error('must not read');}})),{name});
});
test('redirects are disabled to avoid forwarding credentials',async()=>{
 await requestPrices('unit-test-key',[1],async(url,options)=>{assert.equal(options.redirect,'error');assert.equal(new URL(url).hostname,'pyth-lazer.dourolabs.app');return {ok:true,status:200,json:async()=>({evm})};});
});
test('fresh envelope cannot hide carried-forward price',()=>{
 const feed={...parseEnvelope(signed).feeds[0]},now=Number(feed.timestampUs/1000n);
 feed.sourceUs-=23n*3600n*1000000n;assert.deepEqual(priceIssues(feed,now),['price_stale']);
});
test('closed report remains publishable and reports unavailable market',()=>{
 const feed={...parseEnvelope(signed).feeds[0],session:4},now=Number(feed.timestampUs/1000n);
 assert.deepEqual(priceIssues(feed,now),['market_closed']);
});
test('rejects malformed encoding, truncation, extra bytes, duplicate properties',()=>{
 assert.throws(()=>decodeEnvelope({encoding:'base64',data:'!!!'}));
 for(const data of [signed.slice(0,-2),signed+'00'])assert.throws(()=>parseEnvelope(data));
 const raw=Buffer.from(signed.slice(2),'hex');raw[71+31]=3;assert.throws(()=>parseEnvelope('0x'+raw.toString('hex')));
});
test('missing underlying timestamp is parsed as unavailable, never envelope time',()=>{
 const raw=Buffer.from(signed.slice(2),'hex');raw[raw.length-9]=0;
 const shortened=raw.subarray(0,raw.length-8);shortened.writeUInt16BE(shortened.length-71,69);
 const report=parseEnvelope('0x'+shortened.toString('hex'));assert.equal(report.feeds[0].sourceUs,0n);
 assert.ok(priceIssues(report.feeds[0],Number(report.timestampUs/1000n)).includes('price_stale'));
});
