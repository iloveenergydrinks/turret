import test from 'node:test';
import assert from 'node:assert/strict';
import {childEnvironment} from '../src/child-env.mjs';

test('keeper children identify their market in operator alerts',()=>{
 const env=childEnvironment({KEEPER_ALERT_LABEL:''},{symbol:'MSFT',env:{KEEPER_POLL_MS:'5000'}},10100,'keeper',0);
 assert.equal(env.KEEPER_ALERT_LABEL,'MSFT keeper');
 assert.equal(env.PORT,'10100');
});

test('an explicit child alert label is preserved',()=>{
 const env=childEnvironment({}, {symbol:'AAPL',env:{KEEPER_ALERT_LABEL:'Canary keeper'}},10100,'keeper',0);
 assert.equal(env.KEEPER_ALERT_LABEL,'Canary keeper');
});

const manifest=symbol=>({kind:'stock-pool',vault:`fixture-${symbol}`,markets:[{symbol}]});
test('separate risk manifests stay bound to each child and are not inherited as a group',()=>{
 const msft=manifest('MSFT'),nvda=manifest('NVDA');
 const base={EXPANSION_CONFIG_JSON:'[]',EXPANSION_RISK_MANIFESTS_JSON:JSON.stringify({MSFT:msft,NVDA:nvda}),RISK_POLL_MS:'5000'};
 for(const [i,symbol]of ['MSFT','NVDA'].entries()){
  const env=childEnvironment(base,{symbol,env:{RISK_GUARDIAN_KEY:`fixture-${symbol}`,RISK_DATA_DIR:`/data/${symbol}`}},10000+i,'risk',i);
  assert.deepEqual(JSON.parse(env.RISK_MANIFEST_JSON),symbol==='MSFT'?msft:nvda);
  assert.equal(env.RISK_GUARDIAN_KEY,`fixture-${symbol}`);
  assert.equal(env.RISK_DATA_DIR,`/data/${symbol}`);
  assert.equal(env.RISK_POLL_MS,'5000');assert.equal(env.PORT,String(10000+i));
  assert.equal(env.EXPANSION_CONFIG_JSON,undefined);assert.equal(env.EXPANSION_RISK_MANIFESTS_JSON,undefined);
 }
});

test('missing, ambiguous and misbound separate risk manifests are rejected without printing configuration',()=>{
 for(const value of ['', 'private-invalid-json', 'null','[]','{}',JSON.stringify({MSFT:manifest('NVDA')}),
  JSON.stringify({MSFT:{...manifest('MSFT'),kind:'other'}}),JSON.stringify({MSFT:{...manifest('MSFT'),markets:[{symbol:'MSFT'},{symbol:'NVDA'}]}})]){
  assert.throws(()=>childEnvironment({EXPANSION_RISK_MANIFESTS_JSON:value},{symbol:'MSFT',env:{}},10000,'risk',0),
   {message:'Invalid separate risk manifest for MSFT'});
 }
 assert.throws(()=>childEnvironment({EXPANSION_RISK_MANIFESTS_JSON:JSON.stringify({MSFT:manifest('MSFT')})},
  {symbol:'MSFT',env:{RISK_MANIFEST_JSON:'legacy-inline'}},10000,'risk',0),{message:'Ambiguous risk manifest for MSFT'});
});

test('legacy inline risk manifests and other worker kinds retain their behavior',()=>{
 const env=childEnvironment({}, {symbol:'MSFT',env:{RISK_MANIFEST_JSON:'legacy-inline'}},10000,'risk',0);
 assert.equal(env.RISK_MANIFEST_JSON,'legacy-inline');
 const keeper=childEnvironment({EXPANSION_RISK_MANIFESTS_JSON:'not-for-this-worker'},{symbol:'MSFT',env:{}},10100,'keeper',0);
 assert.equal(keeper.EXPANSION_RISK_MANIFESTS_JSON,undefined);assert.equal(keeper.KEEPER_ALERT_LABEL,'MSFT keeper');
});
