import test from 'node:test';
import assert from 'node:assert/strict';
import {stockWatchdogTargets,targetEnvironment} from '../src/stock-watchdog-targets.mjs';

const a='0x'+'11'.repeat(20),b='0x'+'22'.repeat(20),c='0x'+'33'.repeat(20),d='0x'+'44'.repeat(20);
const h='0x'+'ab'.repeat(32);
const target={symbol:'MSFT',keeper:{statusUrl:'https://keeper.example/MSFT/status',statusToken:'k'.repeat(32),expectedMode:'observe',
  expectedVault:a,expectedPool:b,expectedGate:c,expectedCollateral:d,expectedAccount:a,expectedCodeHash:h,expectedPoolCodeHash:h},
  risk:{statusUrl:'https://risk.example/MSFT/status',statusToken:'r'.repeat(32),expectedMode:'execute',expectedVault:a}};

test('validates and maps multiple isolated watchdog targets',()=>{
  const rows=stockWatchdogTargets(JSON.stringify([target,{...target,symbol:'AMD',keeper:{...target.keeper,statusUrl:'https://keeper.example/AMD/status'},risk:{...target.risk,statusUrl:'https://risk.example/AMD/status'}}]));
  assert.equal(rows.length,2);
  assert.deepEqual(targetEnvironment(rows[0],'risk'),{RISK_STATUS_URL:target.risk.statusUrl,RISK_STATUS_TOKEN:target.risk.statusToken,RISK_EXPECTED_MODE:'execute',RISK_EXPECTED_VAULT:a});
  assert.equal(targetEnvironment(rows[0],'keeper').KEEPER_EXPECTED_KIND,'stock');
});

test('rejects unsafe, duplicate and incomplete targets',()=>{
  for(const rows of [[target,target],[{...target,symbol:'msft'}],[{...target,risk:{...target.risk,statusUrl:'http://risk.example/status'}}],[{...target,keeper:{...target.keeper,expectedPool:'bad'}}]])
    assert.throws(()=>stockWatchdogTargets(JSON.stringify(rows)));
});
