import test from 'node:test';
import assert from 'node:assert/strict';
import {api3ConfigFromEnv} from '../src/api3-config.mjs';
import {API3_SERVER,API3_SERVER_HASH} from '../src/api3-usdg.mjs';
const addr=x=>'0x'+x.repeat(40),pin='0x'+'a'.repeat(64);
function fixture(){return {
  env:{ORACLE_RPC_URL:'http://127.0.0.1:8545',ORACLE_STATUS_TOKEN:'local-status-'.repeat(4)},
  manifest:{kind:'stock-api3-usdg',chainId:4663,startBlock:'123',relayAddress:addr('3'),guardian:addr('4'),keeper:addr('5'),
    publication:{adapter:addr('2'),adapterCodeHash:pin}},
};}
test('API3 configuration pins the native server and defaults to a dedicated watch-only identity without provider keys',()=>{
  const f=fixture();f.env.KEEPER_PRIVATE_KEY='must-not-inherit';f.env.KEEPER_VAULT_ADDRESS=addr('f');
  const c=api3ConfigFromEnv(f.env,f.manifest);
  assert.equal(c.mode,'observe');assert.equal(c.privateKey,undefined);assert.equal(c.key,undefined);
  assert.equal(c.vault,API3_SERVER);assert.equal(c.codeHash,API3_SERVER_HASH);
  assert.equal(c.confirmations,2n);assert.equal(c.identity.kind,'stock-api3-usdg');
  assert.deepEqual(c.publication,f.manifest.publication);
  assert.ok(!JSON.stringify(c.identity).includes(f.env.ORACLE_STATUS_TOKEN));
});
test('API3 config rejects unknown identity fields, reused roles and relaxed confirmation or polling settings',()=>{
  for(const change of [f=>{f.manifest.chainId=1;},f=>{f.manifest.kind='isolated-pyth-ratio';},
    f=>{f.manifest.publication.adapterCodeHash='0x'+'0'.repeat(64);},
    f=>{f.manifest.publication.apiKey='never-serialize';},f=>{f.manifest.secret='never-serialize';},
    f=>{f.manifest.relayAddress=f.manifest.guardian;},f=>{f.manifest.keeper=API3_SERVER;},
    f=>{delete f.env.ORACLE_RPC_URL;},f=>{f.env.ORACLE_CONFIRMATIONS='1';},
    f=>{f.env.ORACLE_CONFIRMATIONS='101';},f=>{f.env.ORACLE_POLL_MS='11000';},
    f=>{f.manifest.executionApproved='true';},f=>{f.manifest.reviewDigest='not-a-hash';}]){
    const f=fixture();change(f);assert.throws(()=>api3ConfigFromEnv(f.env,f.manifest));
  }
});
test('API3 execution requires explicit authorization, its own signer and an operator notification destination',()=>{
  const f=fixture();f.env.ORACLE_RELAY_PRIVATE_KEY='0x'+'b'.repeat(64);
  assert.throws(()=>api3ConfigFromEnv(f.env,f.manifest));
  f.env.ORACLE_RELAY_MODE='execute';assert.throws(()=>api3ConfigFromEnv(f.env,f.manifest));
  f.manifest.executionApproved=true;f.manifest.reviewDigest=pin;
  assert.throws(()=>api3ConfigFromEnv(f.env,f.manifest));
  f.env.ORACLE_ALERT_WEBHOOK_URL='https://operator.invalid';
  const config=api3ConfigFromEnv(f.env,f.manifest);assert.equal(config.mode,'execute');
  assert.ok(!JSON.stringify(config.identity).includes(f.env.ORACLE_RELAY_PRIVATE_KEY));
  f.env.ORACLE_ALERT_WEBHOOK_URL='http://operator.invalid';assert.throws(()=>api3ConfigFromEnv(f.env,f.manifest));
});
