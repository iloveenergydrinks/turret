import test from 'node:test';
import assert from 'node:assert/strict';
import {matchCompiledRuntime,RuntimeMismatchError,inspectCollateral} from './recompile-collateral.mjs';
const template='60'+'00'.repeat(32)+'61'+'00'.repeat(32)+'fe';
const deployed='60'+'ab'.repeat(32)+'61'+'ab'.repeat(32)+'fe';
const references={value:[{start:1,length:32},{start:34,length:32}]};
test('runtime matching permits only compiler-declared consistent immutable values',()=>{
  const result=matchCompiledRuntime(template,deployed,references);
  assert.equal(result.immutableValues.value,'0x'+'ab'.repeat(32));assert.equal(result.metadataIgnored,false);
  assert.throws(()=>matchCompiledRuntime(template,deployed),/mismatch/);
  assert.throws(()=>matchCompiledRuntime(template,'62'+deployed.slice(2),references),/mismatch/);
  assert.throws(()=>matchCompiledRuntime(template,deployed.slice(0,-2)+'ff',references),/mismatch/);
  assert.throws(()=>matchCompiledRuntime(template,deployed.slice(0,68)+'cd'.repeat(32)+'fe',references),/Inconsistent/);
});
test('mismatch diagnostics preserve exact byte offsets without treating metadata as verified',()=>{
  assert.throws(()=>matchCompiledRuntime(template,'62'+deployed.slice(2,-2)+'ff',references),error=>{
    assert.ok(error instanceof RuntimeMismatchError);
    assert.equal(error.verification.match,'mismatch');
    assert.equal(error.verification.metadataIgnored,false);
    assert.deepEqual(error.verification.mismatchedByteOffsets,[0,66]);
    assert.equal(error.verification.immutableValues.value,'0x'+'ab'.repeat(32));
    return true;
  });
});
test('inspection rejects invalid identity and block configuration before network access',async()=>{
  const args={token:'0x'+'11'.repeat(20),rpc:'https://invalid.example',solcPath:'/invalid/solc'};
  for(const overrides of [{token:'../bad'},{rpc:''},{solcPath:''},{blockNumber:-1n},{blockNumber:0}]) {
    await assert.rejects(inspectCollateral({...args,...overrides}),/required|Invalid block/);
  }
});
test('malformed ranges and runtime fail closed',()=>{
  for(const refs of [{x:[]},{x:[{start:-1,length:32}]},{x:[{start:1,length:31}]},{x:[{start:100,length:32}]},
    {x:[{start:1,length:32},{start:1,length:32}]}])assert.throws(()=>matchCompiledRuntime(template,deployed,refs));
  for(const code of ['', '0x','xyz',deployed+'00'])assert.throws(()=>matchCompiledRuntime(template,code,references));
});
