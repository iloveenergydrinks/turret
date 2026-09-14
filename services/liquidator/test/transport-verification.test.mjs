import test from 'node:test';
import assert from 'node:assert/strict';
import {acceptSharedTransportVerification} from '../src/transport-verification.mjs';

const store=()=>{const values=new Map();return {values,set:(k,v)=>values.set(k,v)}};
test('accepts only a recent shared transport verification for a configured destination',()=>{
  const now=1_800_000_000_000,s=store();
  assert.equal(acceptSharedTransportVerification(s,String(now-1000),true,now),true);
  assert.equal(s.values.get('transportVerified'),true);
  for(const [value,configured] of [['broken',true],[String(now-3_600_001),true],[String(now+30_001),true],[String(now),false]])
    assert.equal(acceptSharedTransportVerification(store(),value,configured,now),false);
});
