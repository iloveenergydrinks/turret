import test from 'node:test';
import assert from 'node:assert/strict';
import {keccak256} from 'viem';
import {verifyOracleWiring} from './verify-isolated-oracle-wiring.mjs';
import {isolatedConfigFromEnv} from '../../services/oracle-relay/src/isolated-config.mjs';
import {CASHCAT_PAIR} from '../../services/oracle-relay/src/isolated-pyth-preflight.mjs';
import {PYTH_VERIFIER} from '../../services/oracle-relay/src/pyth.mjs';
const addr=n=>'0x'+n.toString(16).padStart(40,'0');
const code='0x60006000',pin=keccak256(code);
function fixture(){
  const p={policy:{...CASHCAT_PAIR},hub:addr(101),adapter:addr(102),hubCodeHash:pin,adapterCodeHash:pin,
    verifierCodeHash:pin,collateralCodeHash:pin,usdgCodeHash:pin};
  const c={credit:{collateral:p.policy.collateral,usdg:p.policy.usdg,primary:addr(104),secondary:p.adapter,guardian:addr(4)},
    intermediate:addr(20),firstPool:addr(21),secondPool:addr(22),pins:Object.fromEntries(['primary','secondary','collateral','usdg','firstPool','secondPool'].map(k=>[k,pin]))};
  const oracle={dex:addr(103),dexCodeHash:pin,manifest:{kind:'isolated-pyth-ratio',chainId:4663,startBlock:'12',
    guardian:c.credit.guardian,keeper:addr(5),relayAddress:addr(6),publication:p,executionApproved:true,reviewDigest:pin}};
  const bindings={hub:p.hub,verifier:PYTH_VERIFIER,collateral:p.policy.collateral,usdg:p.policy.usdg,
    hubCodeHash:pin,verifierCodeHash:pin,referenceFeed:p.adapter,dex:oracle.dex,referenceCodeHash:pin,dexCodeHash:pin,
    intermediate:c.intermediate,firstPool:c.firstPool,secondPool:c.secondPool,firstCodeHash:pin,secondCodeHash:pin,referenceDecimals:18};
  const calls=[],client={async getCode(args){calls.push(args);return code;},async readContract(args){
    calls.push(args);if(Object.hasOwn(bindings,args.functionName))return bindings[args.functionName];
    return BigInt(p.policy[args.functionName]);
  }};
  return {args:{config:c,oracle,client,blockNumber:123n},c,p,oracle,bindings,calls,client};
}
test('commissioning links market, relay, corroborated reference and DEX exit route at one block',async()=>{
  const f=fixture(),result=await verifyOracleWiring(f.args);
  assert.equal(result.wiringVerified,true);assert.ok(f.calls.every(c=>c.blockNumber===123n));
  const manifest=JSON.parse(result.relayCandidate.ISOLATED_ORACLE_MANIFEST_JSON);
  assert.equal(manifest.executionApproved,false);assert.equal(manifest.reviewDigest,undefined);
  assert.equal(result.relayCandidate.ORACLE_RELAY_MODE,'observe');
  const config=isolatedConfigFromEnv({ORACLE_RPC_URL:'http://127.0.0.1',ORACLE_STATUS_TOKEN:'test-status-'.repeat(3),PYTH_API_KEY:'local-only'},manifest);
  assert.equal(result.watchdogCandidate.ISOLATED_ORACLE_EXPECTED_IDENTITY_HASH,config.identityHash);
  assert.equal(result.productionApproved,false);assert.equal(result.installed,false);
  assert.equal(result.sourceIndependenceVerified,false);assert.equal(result.oracleProviderAccessVerified,false);
  assert.ok(!JSON.stringify(result,(_,v)=>typeof v==='bigint'?String(v):v).includes('commissioning-placeholder'));
});
test('different market, guardian, runtime pins or future start block are not commissionable',async()=>{
  for(const mutate of [f=>{f.oracle.manifest.guardian=addr(9);},f=>{f.p.adapter=addr(9);},
    f=>{f.p.policy.collateral='0x39dbed3a2bd333467115de45665cc57f813c4571';},
    f=>{f.p.adapterCodeHash='0x'+'b'.repeat(64);},f=>{f.oracle.manifest.startBlock='124';},
    f=>{f.oracle.dex=f.p.adapter;},f=>{f.oracle.dexCodeHash='0x'+'b'.repeat(64);}]){
    const f=fixture();mutate(f);await assert.rejects(verifyOracleWiring(f.args));
  }
});
test('reference substitution, different DEX exit pools and nested runtime pins fail',async()=>{
  for(const name of ['referenceFeed','dex','intermediate','firstPool','secondPool','referenceCodeHash','dexCodeHash','firstCodeHash','secondCodeHash','referenceDecimals']){
    const f=fixture();f.bindings[name]=name==='referenceDecimals'?8:name.endsWith('Hash')?'0x'+'b'.repeat(64):addr(999);
    await assert.rejects(verifyOracleWiring(f.args),/mismatch/);
  }
});
test('unexpected secret fields and missing explicit oracle inputs cannot become candidates',async()=>{
  for(const mutate of [f=>{f.oracle.privateKey='secret';},f=>{f.oracle.manifest.publication.apiKey='secret';},
    f=>{delete f.oracle.dexCodeHash;},f=>{f.args.blockNumber=undefined;}]){
    const f=fixture();mutate(f);await assert.rejects(verifyOracleWiring(f.args));
  }
});
test('missing or changed oracle runtime stops commissioning',async()=>{
  for(const code of ['0x',undefined,'0x60']){
    const f=fixture();f.client.getCode=async()=>code;await assert.rejects(verifyOracleWiring(f.args),/runtime/);
  }
});
