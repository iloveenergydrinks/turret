import test from 'node:test';import assert from 'node:assert/strict';import{failureResult,workerStatus}from'../src/status.mjs';
test('live but blocked worker reports non-operational and safe cause',()=>{
 const s=workerStatus('execute',failureResult(Error('quote_unavailable')));assert.equal(s.operational,false);assert.equal(s.errorCode,'quote_unavailable');
 assert.equal(workerStatus('execute',{reason:'quote_rate_limited',nextRetryAt:1000000}).nextRetryAt,'1970-01-01T00:16:40.000Z');
 assert.equal(workerStatus('execute',{reason:'waiting_for_hour_balance_or_allowance'}).operational,true);
 assert.equal(workerStatus('execute',{reason:'confirmed'}).operational,true);
 assert.equal(workerStatus('observe',{reason:'confirmed'}).operational,false);
 assert(!JSON.stringify(failureResult(Error('secret endpoint https://private.invalid/key'))).includes('private'));
});
