import test from 'node:test';
import assert from 'node:assert/strict';
import {assertCanaryFunding} from './stock-canary-funding.mjs';
const amount=250000000n,shares=amount*1000000n;
const funded={oldCash:0n,poolCash:amount,totalAssets:amount,totalSupply:shares,ownerShares:shares,maxWithdraw:amount};
test('funded mode verifies full owner recovery and minted shares',()=>assert.equal(assertCanaryFunding(funded,{funded:true}).newPoolUSDG,'250'));
test('direct USDG transfer without lender shares is not accepted',()=>assert.throws(()=>assertCanaryFunding({...funded,totalSupply:0n,ownerShares:0n},{funded:true})));
test('missing owner shares or reduced recoverability is not accepted',()=>{
  for(const patch of [{ownerShares:0n},{maxWithdraw:amount-1n},{oldCash:amount}])assert.throws(()=>assertCanaryFunding({...funded,...patch},{funded:true}));
});
test('default commissioning still requires funds in the old vault',()=>{
  assert.equal(assertCanaryFunding({oldCash:amount,poolCash:0n,totalAssets:0n,totalSupply:0n,ownerShares:0n,maxWithdraw:0n}).newPoolUSDG,'0');
  assert.throws(()=>assertCanaryFunding(funded));
});
