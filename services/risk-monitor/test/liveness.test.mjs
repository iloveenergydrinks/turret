import test from 'node:test';
import assert from 'node:assert/strict';
import {LivenessTracker,makeLivenessProof} from '../src/liveness.mjs';
import {privateKeyToAccount} from '../src/deps.mjs';
const options={consistent:true,healthyProviders:2,recoveryAt:0};
const head=t=>({timestamp:BigInt(t),number:BigInt(t)*10n,hash:`hash-${t}`});
function recovered(){const tracker=new LivenessTracker();let result;for(let t=1000;t<=1120;t+=15)result=tracker.observe(head(t),t,options);assert.equal(result.ok,true);return tracker;}
test('liveness requires two minutes of fresh, agreeing observations',()=>{
 const tracker=new LivenessTracker();for(let t=1000;t<1120;t+=15)assert.equal(tracker.observe(head(t),t,options).ok,false);
 assert.equal(tracker.observe(head(1120),1120,options).ok,true);
});
test('an explicit one-provider MVP policy still requires two minutes of recovery',()=>{
 const tracker=new LivenessTracker(),single={...options,healthyProviders:1,requiredHealthyProviders:1};
 for(let t=1000;t<1120;t+=15)assert.equal(tracker.observe(head(t),t,single).ok,false);
 assert.equal(tracker.observe(head(1120),1120,single).ok,true);
 assert.equal(new LivenessTracker().observe(head(1120),1120,{...options,healthyProviders:1}).ok,false);
});
test('outage, process stall, reorg and provider loss all restart recovery',()=>{
 for(const [h,wall,opts] of [[head(1200),1200,options],[head(1121),1200,options],[head(1135),1135,{...options,consistent:false}],
  [head(1135),1135,{...options,healthyProviders:1}],[head(1110),1125,options],[{...head(1120),hash:'reorg'},1121,options]]){
  const tracker=recovered();assert.equal(tracker.observe(h,wall,opts).ok,false);
  assert.equal(tracker.observe(head(1215),1215,options).ok,false);
 }
 assert.equal(new LivenessTracker().observe(head(1120),1120,options).ok,false);
});
test('onchain stop timestamp cannot inherit an older recovery interval',()=>{
 const tracker=recovered();assert.equal(tracker.observe(head(1135),1135,{...options,recoveryAt:1130}).ok,false);
});
test('liveness is signed independently of stock market hours and expires within 45 seconds',async()=>{
 const tracker=recovered(),result=tracker.observe(head(1135),1135,options);
 const account=privateKeyToAccount(`0x${'1'.padStart(64,'0')}`);
 const proof=await makeLivenessProof(account,'0x1111111111111111111111111111111111111111',result,0n);
 assert.equal(proof.validUntil,1180);assert.match(proof.encoded,/^0x[0-9a-f]+$/);
 await assert.rejects(makeLivenessProof(account,'0x1111111111111111111111111111111111111111',{...result,ok:false},0n));
});
