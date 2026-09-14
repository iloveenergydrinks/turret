import test from 'node:test';
import assert from 'node:assert/strict';
import {riskRuntimePolicy} from '../src/runtime-policy.mjs';

test('risk runtime keeps quorum defaults and permits an explicit lower-cost one-provider MVP',()=>{
 assert.deepEqual(riskRuntimePolicy({},true),{requiredHealthyProviders:2,pollMs:5000,deploymentVerifyIntervalMs:60000});
 assert.deepEqual(riskRuntimePolicy({RISK_MIN_HEALTHY_RPC_PROVIDERS:'1',RISK_POLL_MS:'15000'},true),
  {requiredHealthyProviders:1,pollMs:15000,deploymentVerifyIntervalMs:60000});
 for(const patch of [{RISK_MIN_HEALTHY_RPC_PROVIDERS:'0'},{RISK_MIN_HEALTHY_RPC_PROVIDERS:'3'},
  {RISK_POLL_MS:'30000'},{RISK_DEPLOYMENT_VERIFY_INTERVAL_MS:'9999'}])assert.throws(()=>riskRuntimePolicy(patch,true));
});
