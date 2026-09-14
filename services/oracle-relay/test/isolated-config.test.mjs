import test from 'node:test';
import assert from 'node:assert/strict';
import {isolatedConfigFromEnv} from '../src/isolated-config.mjs';
import {CASHCAT_PAIR as policy} from '../src/isolated-pyth-preflight.mjs';
const addr=x=>'0x'+x.repeat(40),pin='0x'+'a'.repeat(64);
function fixture(){
  return {env:{ORACLE_RPC_URL:'http://127.0.0.1:8545',ORACLE_STATUS_TOKEN:'local-test-'.repeat(4),PYTH_API_KEY:'fake-local'},
    manifest:{kind:'isolated-pyth-ratio',chainId:4663,startBlock:'123',relayAddress:addr('3'),guardian:addr('4'),keeper:addr('5'),
      publication:{policy:{...policy},hub:addr('1'),adapter:addr('2'),hubCodeHash:pin,adapterCodeHash:pin,
        verifierCodeHash:pin,collateralCodeHash:pin,usdgCodeHash:pin}}};
}
test('explicit isolated config stays observe-only, binds journal identity and ignores stock signer/defaults',()=>{
  const f=fixture();f.env.KEEPER_PRIVATE_KEY='never-read';f.env.KEEPER_VAULT_ADDRESS=addr('f');
  const c=isolatedConfigFromEnv(f.env,f.manifest);
  assert.equal(c.mode,'observe');assert.equal(c.privateKey,undefined);assert.equal(c.vault,f.manifest.publication.hub);
  assert.deepEqual(c.identity.publication,f.manifest.publication);
});
test('invalid chain/assets, absent pins, reused signer or missing isolated RPC rejected',()=>{
  for(const mode of ['chain','asset','pin','signer','rpc','confirmation']){
    const f=fixture();
    if(mode==='chain')f.manifest.chainId=1;
    if(mode==='asset')f.manifest.publication.policy.collateral=addr('e');
    if(mode==='pin')delete f.manifest.publication.hubCodeHash;
    if(mode==='signer')f.manifest.relayAddress=f.manifest.guardian;
    if(mode==='rpc')delete f.env.ORACLE_RPC_URL;
    if(mode==='confirmation')f.env.ORACLE_CONFIRMATIONS='1';
    assert.throws(()=>isolatedConfigFromEnv(f.env,f.manifest));
  }
});
test('observe refuses keys; execution requires explicit authorization, signer and alert destination',()=>{
  const f=fixture();f.env.ORACLE_RELAY_PRIVATE_KEY='0x'+'b'.repeat(64);
  assert.throws(()=>isolatedConfigFromEnv(f.env,f.manifest));
  f.env.ORACLE_RELAY_MODE='execute';assert.throws(()=>isolatedConfigFromEnv(f.env,f.manifest));
  f.manifest.executionApproved=true;f.manifest.reviewDigest=pin;
  assert.throws(()=>isolatedConfigFromEnv(f.env,f.manifest));
  f.env.ORACLE_ALERT_WEBHOOK_URL='https://example.invalid';
  assert.equal(isolatedConfigFromEnv(f.env,f.manifest).mode,'execute');
});
test('verification-value budget uses exact positive wei, separate from gas',()=>{
  const f=fixture();assert.equal(isolatedConfigFromEnv(f.env,f.manifest).maxDailyVerificationValue,20000000000000n);
  for(const invalid of ['0','-1','1.5','1e9','01','1000000000000000000']){
    f.env.ORACLE_DAILY_VERIFICATION_FEE_WEI=invalid;assert.throws(()=>isolatedConfigFromEnv(f.env,f.manifest));
  }
  f.env.ORACLE_DAILY_VERIFICATION_FEE_WEI='123';
  assert.equal(isolatedConfigFromEnv(f.env,f.manifest).maxDailyVerificationValue,123n);
});
test('unexpected manifest fields and malformed approval metadata are rejected before serialization',()=>{
  for(const mutate of [f=>{f.manifest.privateKey='not-allowed';},f=>{f.manifest.publication.apiKey='not-allowed';},
    f=>{f.manifest.publication.policy.extra=true;},f=>{f.manifest.publication.policy.collateralSymbol={secret:'not-allowed'};},
    f=>{f.manifest.executionApproved='true';},f=>{f.manifest.reviewDigest='not-a-hash';}]){
    const f=fixture();mutate(f);assert.throws(()=>isolatedConfigFromEnv(f.env,f.manifest));
  }
});
