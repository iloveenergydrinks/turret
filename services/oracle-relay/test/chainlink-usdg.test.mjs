import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {spawnSync} from 'node:child_process';
import {inspectChainlinkUsdg} from '../src/chainlink-usdg.mjs';
const {encodeAbiParameters,parseAbiParameters}=createRequire(new URL('../../liquidator/package.json',import.meta.url))('viem');
const feed='0x00032a5d7bd525026e8a09dd481e5d21db9e22671943727dc31b9408f577125f';
const word='0x'+'11'.repeat(32);
// ABI fixture with fake signatures: it must never be labelled verified.
function responseReport(overrides={}) {
  const fields={feed,valid:1700000000,observed:1700000001,expires:1700000030,
    price:1000000000000000000n,bid:999000000000000000n,ask:1001000000000000000n,...overrides};
  const report=encodeAbiParameters(parseAbiParameters('bytes32,uint32,uint32,uint192,uint192,uint32,int192,int192,int192'),
    [fields.feed,fields.valid,fields.observed,0n,0n,fields.expires,fields.price,fields.bid,fields.ask]);
  const fullReport=encodeAbiParameters(parseAbiParameters('bytes32[3],bytes,bytes32[],bytes32[],bytes32'),
    [[word,word,word],report,[word],[word],word]);
  return {report:{feedID:fields.feed,validFromTimestamp:fields.valid,observationsTimestamp:fields.observed,fullReport}};
}

test('USDG access errors expose neither credentials nor provider response bodies', async () => {
  for (const status of [401,403,429,500]) {
    await assert.rejects(inspectChainlinkUsdg({key:'test-user',secret:'test-secret',
      fetcher:async()=>new Response('sensitive-provider-body',{status})}),
    {message:status===401||status===403?'StreamsAccessDenied':status===429?'StreamsRateLimited':'StreamsUnavailable'});
  }
});

test('CLI fails closed with sanitized output when credentials are missing',()=>{
  const result=spawnSync(process.execPath,['src/chainlink-usdg.mjs'],{encoding:'utf8',env:{PATH:process.env.PATH}});
  assert.equal(result.status,1);
  assert.deepEqual(JSON.parse(result.stderr),{probe:'failed',error:'StreamsCredentialsMissing',productionChanged:false});
});

test('inspects the USDG report bytes without claiming fake signatures are verified', async () => {
  const response=responseReport();response.report.price='999999';
  const result=await inspectChainlinkUsdg({key:'test-user',secret:'test-secret',now:()=>1700000002000,
    fetcher:async(url,options)=>{
      assert.equal(url,`https://api.dataengine.chain.link/api/v1/reports/latest?feedID=${feed}`);
      assert.equal(options.redirect,'error');assert.equal(options.method,'GET');
      assert.equal(options.headers['X-Authorization-Timestamp'],'1700000002000');
      // Independent OpenSSL HMAC-SHA256 fixture, using test-only credentials.
      assert.equal(options.headers['X-Authorization-Signature-SHA256'],'8ed34b51bad1f7a6ce15485ec07d47a38e60840c7637beb7a09a4d78592e1e81');
      return Response.json(response);
    }});
  assert.equal(result.price,1000000000000000000n);
  assert.equal(result.ageSeconds,1);
  assert.equal(result.priceChecksPassed,true);
  assert.equal(result.signatureVerified,false);
  assert.equal(result.productionApproved,false);
  assert.equal(result.productionChanged,false);
});

test('report time and price-quality failures never pass candidate checks',async()=>{
  for(const change of [{observed:1699999942,valid:1699999941},{observed:1700000003},
    {expires:1700000002},{valid:1700000002},{price:0n},{bid:1002000000000000000n},
    {ask:990000000000000000n},{ask:1020000000000000000n}]) {
    const result=await inspectChainlinkUsdg({key:'test-user',secret:'test-secret',now:()=>1700000002000,
      fetcher:async()=>Response.json(responseReport(change))});
    assert.equal(result.priceChecksPassed,false,JSON.stringify(change,(_,v)=>typeof v==='bigint'?String(v):v));
  }
});

test('substituted feeds and malformed envelopes are rejected',async()=>{
  const wrongWrapper=responseReport();wrongWrapper.report.observationsTimestamp++;
  const trailing=responseReport();trailing.report.fullReport+='00';
  for(const body of [wrongWrapper,trailing,responseReport({feed:word}),{report:{fullReport:'0x12'}}]) {
    await assert.rejects(inspectChainlinkUsdg({key:'test-user',secret:'test-secret',now:()=>1700000002000,
      fetcher:async()=>Response.json(body)}));
  }
});

test('oversized responses, network errors and malformed JSON stay bounded and sanitized',async()=>{
  for(const fetcher of [
    async()=>new Response('sensitive',{headers:{'Content-Length':'65537'}}),
    async()=>new Response(new ReadableStream({start(c){c.enqueue(new Uint8Array(65537));c.close();}})),
    async()=>new Response('test-secret malformed json'),
    async()=>{throw Error('test-secret failed URL');},
  ]) {
    await assert.rejects(inspectChainlinkUsdg({key:'test-user',secret:'test-secret',fetcher}),
      error=>['StreamsResponseTooLarge','StreamsProbeFailed'].includes(error.message)&&!error.cause);
  }
});
