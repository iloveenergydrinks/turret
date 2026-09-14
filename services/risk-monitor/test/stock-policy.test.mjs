import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {privateKeyToAccount} from '../src/deps.mjs';
import {makeStockProof,marketHealthTypes,stockProofParameters} from '../src/stock-policy.mjs';
import {healthTypes,proofParameters} from '../src/policy.mjs';
const require=createRequire(new URL('../../liquidator/package.json',import.meta.url));
const {decodeAbiParameters,recoverTypedDataAddress}=require('viem');
test('stock health carries two signatures and engine authorization cannot move across engine or chain',async()=>{
 const account=privateKeyToAccount(`0x${'1'.padStart(64,'0')}`),engine='0x1111111111111111111111111111111111111111',adapter='0x2222222222222222222222222222222222222222';
 const now=1800000000,result={ok:true,roundId:7n,roundHash:`0x${'33'.repeat(32)}`,sourceTime:now-30,sessionOpen:now-120,sessionClose:now+3600};
 const p=await makeStockProof(account,engine,adapter,result,{epoch:4n,recoveryAt:0n},now);
 assert.equal(p.validUntil,now+30);
 const [message,priceSignature,signature]=decodeAbiParameters(stockProofParameters,p.encoded);
 const guardDomain={name:'DockyardChainlinkGuard',version:'1',chainId:4663,verifyingContract:adapter};
 const marketDomain={name:'DockyardStockCredit',version:'1',chainId:4663,verifyingContract:engine};
 assert.equal(await recoverTypedDataAddress({domain:guardDomain,types:healthTypes,primaryType:'Health',message,signature:priceSignature}),account.address);
 assert.equal(await recoverTypedDataAddress({domain:marketDomain,types:marketHealthTypes,primaryType:'MarketHealth',message,signature}),account.address);
 for(const patch of [{chainId:1},{verifyingContract:adapter},{name:'DockyardChainlinkGuard'}]){
  assert.notEqual(await recoverTypedDataAddress({domain:{...marketDomain,...patch},types:marketHealthTypes,primaryType:'MarketHealth',message,signature}),account.address);
 }
 // The original guard can read its signature for quarantine recovery, without
 // accepting the engine signature as price authorization.
 assert.deepEqual(decodeAbiParameters(proofParameters,p.encoded),[message,priceSignature]);
 await assert.rejects(makeStockProof(account,engine,adapter,{...result,sourceTime:now-46},{epoch:4n,recoveryAt:0n},now));
});
