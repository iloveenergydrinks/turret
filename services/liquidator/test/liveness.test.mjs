import test from 'node:test';
import assert from 'node:assert/strict';
import {fetchLiveness} from '../src/liveness.mjs';
const config={chainId:4663,vault:'0x1111111111111111111111111111111111111111',executionGate:'0x2222222222222222222222222222222222222222',livenessUrl:'https://example.invalid/liveness'};
const valid={...config,validUntil:1030,encoded:'0x'+'aa'.repeat(256)};
const response=p=>async()=>({ok:true,json:async()=>p});
test('keeper accepts only matching, fresh execution proofs',async()=>{
 assert.equal(await fetchLiveness(config,response(valid),1000),valid.encoded);
 for(const patch of [{chainId:1},{vault:config.executionGate},{executionGate:config.vault},{validUntil:1009},{validUntil:1046},{validUntil:'1030'},{encoded:'0xabc'},{encoded:null}]){
  await assert.rejects(fetchLiveness(config,response({...valid,...patch}),1000),/invalid/);
 }
});
test('keeper fails closed when proof service is unavailable',async()=>{
 await assert.rejects(fetchLiveness(config,async()=>({ok:false}),1000),/unavailable/);
 await assert.rejects(fetchLiveness(config,async()=>{throw new Error('network');},1000),/network/);
});
