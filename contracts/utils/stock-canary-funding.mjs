import assert from 'node:assert/strict';

// Funding verification is separate from permission to open borrowing. A token
// transfer without lender shares must never count as successful migration.
export function assertCanaryFunding(s,{funded=false}={}) {
  const amount=250000000n,poolCash=funded?amount:0n,shares=poolCash*1000000n;
  assert.equal(s.oldCash,amount-poolCash,'Unexpected old-vault funding');
  assert.equal(s.poolCash,poolCash,'Unexpected lender-pool USDG');
  assert.equal(s.totalAssets,poolCash,'Pool assets do not reconcile to idle cash');
  assert.equal(s.totalSupply,shares,'Expected share-minting deposit, not a direct transfer');
  assert.equal(s.ownerShares,shares,'Lender shares must belong to the owner');
  assert.equal(s.maxWithdraw,poolCash,'Owner must be able to recover all idle pool funding');
  return {oldVaultUSDG:funded?'0':'250',newPoolUSDG:funded?'250':'0',fundingState:funded?'owner-funded-paused':'unfunded-paused'};
}
