import test from 'node:test';
import assert from 'node:assert/strict';
import {monitorReadiness} from '../src/readiness.mjs';

test('fresh debt monitoring permits settings without claiming fresh liquidation risk',()=>{
 const result=monitorReadiness({healthyAt:0,operationalAt:100000,monitorReason:'liveness_unavailable'},100001);
 assert.equal(result.monitorReady,false);assert.equal(result.monitorOperational,true);
 assert.equal(result.monitorReason,'liveness_unavailable');assert.equal(result.lastRiskCheckAt,null);
});
test('both kinds of readiness expire, and future timestamps never certify monitoring',()=>{
 for(const timestamp of [0,10000,100001,NaN,undefined]){
  const result=monitorReadiness({healthyAt:timestamp,operationalAt:timestamp,monitorReason:'ready'},100000);
  assert.equal(result.monitorReady,false);assert.equal(result.monitorOperational,false);
  assert.equal(result.monitorReason,'unavailable');
 }
});
test('legacy monitors remain compatible and known failures revoke readiness immediately',()=>{
 assert.equal(monitorReadiness({healthyAt:100000},100001).monitorOperational,true);
 assert.equal(monitorReadiness({healthyAt:0,operationalAt:0,monitorReason:'positions_unavailable'},100001).monitorOperational,false);
 assert.equal(monitorReadiness({healthyAt:0,operationalAt:100000,monitorReason:'secret provider error'},100001).monitorReason,'unavailable');
});
