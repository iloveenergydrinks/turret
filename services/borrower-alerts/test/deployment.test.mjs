import test from 'node:test';
import assert from 'node:assert/strict';
import {alertsDeployment,bindDeployment,LEGACY_VAULT} from '../src/deployment.mjs';
const address='0x1111111111111111111111111111111111111111',hash=`0x${'ab'.repeat(32)}`;
test('legacy target is preserved and overrides require a code hash',()=>{
 assert.equal(alertsDeployment({}).vault,LEGACY_VAULT);
 assert.throws(()=>alertsDeployment({ALERTS_VAULT_ADDRESS:address}));
 assert.throws(()=>alertsDeployment({ALERTS_VAULT_CODE_HASH:hash}));
 assert.equal(alertsDeployment({ALERTS_VAULT_ADDRESS:address,ALERTS_VAULT_CODE_HASH:hash}).vault,address);
});
test('a different vault cannot inherit old subscription or event state',()=>{
 const store={get:()=>({vault:LEGACY_VAULT}),all:()=>[],put:()=>{throw new Error('must not modify');}};
 assert.throws(()=>bindDeployment(store,{vault:address}),/separate/);
 store.get=()=>null;store.all=()=>[{wallet:address}];
 assert.throws(()=>bindDeployment(store,{vault:address}),/legacy/);
});
