// Read-only verification of the completed local browser run; never targets production.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {createPublicClient,http,decodeFunctionData,decodeEventLog,erc20Abi} from 'viem';
const root=new URL('../../../',import.meta.url);
const path=relative=>new URL(relative,root);
const fixture=await(await fetch('http://127.0.0.1:4291/fixture')).json();
assert.ok(fixture.rpc.startsWith('http://127.0.0.1:'));
const client=createPublicClient({transport:http(fixture.rpc),cacheTime:0});
assert.equal(await client.getChainId(),4663);
const evidence=await(await fetch('http://127.0.0.1:4291/evidence')).json();
assert.equal(evidence.debt,'0');assert.equal(evidence.collateralBalance,'20000000000000000000');
const earned=evidence.accounts[0];
assert.equal(BigInt(evidence.claimed),BigInt(earned.eligiblePaidInterest)/2n);
assert.equal(evidence.claimed,earned.confirmedRebate);
assert.ok(BigInt(evidence.claimed)>0n);
const engineABI=JSON.parse(readFileSync(path('output/central-credit-20260908/contracts/out/TurretCreditEngine.sol/TurretCreditEngine.json'))).abi;
const campaignABI=JSON.parse(readFileSync(path('contracts/rewards/out/TurretBorrowerCashback.sol/TurretBorrowerCashback.json'))).abi;
const addresses=[fixture.market.engine,fixture.market.collateral,fixture.config.rewardToken,fixture.config.deployment.address];
const logs=(await Promise.all(addresses.map(address=>client.getLogs({address,fromBlock:1n})))).flat();
const transactions=[];
for(const hash of new Set(logs.map(log=>log.transactionHash))){
 const tx=await client.getTransaction({hash});if(tx.from.toLowerCase()!==fixture.borrower.toLowerCase())continue;
 const receipt=await client.getTransactionReceipt({hash});assert.equal(receipt.status,'success');
 const abi=tx.to.toLowerCase()===fixture.market.engine.toLowerCase()?engineABI:tx.to.toLowerCase()===fixture.config.deployment.address.toLowerCase()?campaignABI:erc20Abi;
 const decoded=decodeFunctionData({abi,data:tx.input});
 transactions.push({hash,nonce:tx.nonce,function:decoded.functionName,args:decoded.args,blockNumber:receipt.blockNumber});
}
transactions.sort((a,b)=>a.nonce-b.nonce);
assert.deepEqual(transactions.map(tx=>tx.function),['approve','executeApproved','approve','close','claim']);
const borrowed=transactions[1];assert.equal(borrowed.args[0].debtAmount,365000000n);assert.equal(borrowed.args[0].collateralAmount,20n*10n**18n);
const borrowReceipt=await client.getTransactionReceipt({hash:borrowed.hash});
const transfers=borrowReceipt.logs.filter(log=>log.address.toLowerCase()===fixture.config.rewardToken.toLowerCase()).map(log=>{try{return decodeEventLog({abi:erc20Abi,...log});}catch{return null;}});
assert.ok(transfers.some(e=>e?.eventName==='Transfer'&&e.args.from.toLowerCase()===fixture.market.pool.toLowerCase()&&e.args.to.toLowerCase()===fixture.borrower.toLowerCase()&&e.args.value===365000000n));
const sources=['output/borrower-cashback-20260911/frontend-source/frontend/app/src/screens/IsolatedMarketScreen/IsolatedMarketScreen.tsx',
 'frontend/app/src/borrow/BorrowProgress.tsx','frontend/app/src/borrow/BorrowEstimate.tsx','frontend/app/src/borrow/LoanCostDetails.tsx',
 'frontend/app/src/borrower-cashback/CashbackPortfolio.tsx','frontend/app/src/borrower-cashback/transactions.ts'];
const report={localOnly:true,checkedAt:new Date().toISOString(),chain:evidence,borrowerTransactions:transactions,
 browserObserved:['Wallet showed 20 AAPL; entering 20 AAPL/365 USDG gave 600 USDG capacity and 18.25% starting LTV',
 '7-day estimate: 10% APR, 0.7 USDG gross, 0.35 rebate, 0.35 net; dates and 10 USDG reserved cap shown',
 'Approval review and final loan review retained the 7-day period and cost figures',
 'Progress stayed visible: 3 steps before approval, 2 after mined approval, 1 while loan was pending, Loan confirmed only after receipt',
 'Before repayment: confirmed 0 and claimable 0; unpaid estimate separate',
 'After advancing 30 days, rewards API was disabled and full repayment/approval still completed',
 'UI showed debt 0 and all 20 AAPL restored to wallet',
 'After rewards API restoration: confirmed 0.450013 USDG, claimable 0 before publication',
 'After publication: claimable 0.450013; reviewed and claimed in browser; receipt-backed success, already claimed 0.450013 and available 0'],
 sourceHashes:sources.map(source=>({source,sha256:createHash('sha256').update(readFileSync(path(source))).digest('hex')})),
 fixture:'Signed test quotes are anchored to mined block time. Production screen matches its release overlay byte-for-byte; only test wallet/transport/campaign/clock are substituted.'};
writeFileSync(path('output/borrower-cashback-20260911/connected-loan-e2e-evidence.json'),JSON.stringify(report,(_,v)=>typeof v==='bigint'?String(v):v,2)+'\n');
console.log(JSON.stringify({verifiedBorrowerTransactions:transactions.length,debt:evidence.debt,collateralReturned:'20 AAPL',cashback:evidence.claimed}));
