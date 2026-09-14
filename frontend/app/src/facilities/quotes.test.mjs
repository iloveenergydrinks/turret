import test from "node:test";
import assert from "node:assert/strict";
import { mnemonicToAccount } from "viem/accounts";
import { assessQuote, drawAmounts, parseSignedQuote, quoteDigest, quoteTypedData, summarizeFacilities, UINT_MAX, ZERO_ADDRESS, ZERO_HASH } from "./quotes.mjs";
import { verifyFacilitySignature } from "./signatures.mjs";

const now=1_800_000_000_000;
const addr=n=>`0x${n.toString(16).padStart(40,"0")}`;
const signer=mnemonicToAccount("test test test test test test test test test test test junk");
function envelope(overrides={}) {
  return {schemaVersion:1,chainId:31337,facility:addr(1),signature:"0x",quote:{epoch:"1",nonce:"1",borrower:ZERO_ADDRESS,
    capacity:"300000000",minDraw:"1000000",collateralForCapacity:"600000000000000000000",interestForCapacity:"30000000",
    duration:"604800",validAfter:"1800000000",expiresAt:"1800000600",...overrides}};
}
function observation(overrides={}) {
  return {facility:addr(1),chainId:31337,lender:signer.address,healthy:true,signatureValid:true,paused:false,
    epoch:1n,idleCash:500_000000n,cashBalance:500_000000n,activePrincipal:0n,unresolvedDefaultPrincipal:0n,feeBps:1000n,
    limits:{maxExposure:500_000000n,minDraw:1_000000n,maxDraw:300_000000n,minDuration:86400n,maxDuration:2592000n,
      maxQuoteLifetime:3600n,minCollateralPerPrincipalWad:10n**30n,minInterestBps:100n},
    use:{digest:ZERO_HASH,filled:0n,cancelled:false},block:{number:1n,hash:`0x${"a".repeat(64)}`,timestamp:1800000000n},checkedAt:now,...overrides};
}
const assess=(e=envelope(),s=observation(),options={})=>assessQuote(e,s,{now,...options});
const row=(e=envelope(),s=observation())=>({envelope:e,observation:s});
const summary=rows=>summarizeFacilities(rows,{now})[0];

test("signed payload has exact canonical fields and domain-separated identity",()=>{
  const e=envelope();assert.deepEqual(parseSignedQuote(e),e);
  for(const changed of [{...e,chainId:4663},{...e,facility:addr(2)},{...e,quote:{...e.quote,nonce:"2"}}])assert.notEqual(quoteDigest(e),quoteDigest(changed));
  for(const bad of ["01","-1","1.0",1,"1e6",(UINT_MAX+1n).toString()])assert.throws(()=>parseSignedQuote(envelope({capacity:bad})));
  for(const bad of [{...e,extra:1},{...e,signature:"0x1"},{...e,chainId:0},envelope({duration:"1"}),envelope({extra:"1"}),envelope({borrower:addr(1)}),envelope({capacity:UINT_MAX.toString()})])assert.throws(()=>parseSignedQuote(bad));
});
test("partial draws round collateral and interest up and the protocol fee down",()=>{
  const e=envelope({capacity:"3",minDraw:"1",collateralForCapacity:"10",interestForCapacity:"2"});
  assert.deepEqual(drawAmounts(e,1n,1000n),{principal:1n,collateral:4n,interest:1n,repayment:2n,fee:0n,lenderRepayment:2n});
  for(let p=1n;p<=3n;p++) {
    const a=drawAmounts(e,p,1000n);assert(a.collateral*3n>=p*10n);assert(a.interest*3n>=p*2n);assert.equal(a.lenderRepayment+a.fee,a.repayment);
  }
  assert.equal(drawAmounts(envelope(),100_000000n,1000n).fee,1_000000n);
});
test("available capital is backed cash constrained by active AND unresolved default exposure",()=>{
  assert.equal(assess().maxDraw,300_000000n);
  const s=observation({activePrincipal:200_000000n,unresolvedDefaultPrincipal:250_000000n});
  assert.equal(assess(envelope(),s).capacity,50_000000n);
  assert.equal(assess(envelope(),{...s,cashBalance:499_000000n}).status,"unavailable");
  assert.equal(assess(envelope(),{...s,activePrincipal:500_000000n}).status,"unfunded");
  assert.equal(assess(envelope(),observation({cashBalance:1000_000000n})).capacity,300_000000n,"donations do not create recorded idle cash");
});
test("monotonic nonce fill, cancellation, signer invalidation and policy epochs stop old quotes",()=>{
  const e=envelope(),digest=quoteDigest(e);
  assert.equal(assess(e,observation({use:{digest,filled:299_000000n,cancelled:false}})).capacity,1_000000n);
  assert.equal(assess(e,observation({use:{digest,filled:299_000001n,cancelled:false}})).status,"filled");
  assert.equal(assess(e,observation({use:{digest,filled:301_000000n,cancelled:false}})).status,"unavailable");
  for(const s of [observation({epoch:2n}),observation({signatureValid:false}),observation({use:{digest,filled:0n,cancelled:true}}),observation({use:{digest:ZERO_HASH,filled:1n,cancelled:false}})])assert.equal(assess(e,s).status,"revoked");
  assert.equal(assess(e,observation({paused:true})).status,"paused");
});
test("time boundaries require both local time and the verified block to permit execution",()=>{
  assert.equal(assess(envelope({expiresAt:"1800000000",validAfter:"1799999999"})).status,"expired");
  assert.equal(assess(envelope({validAfter:"1800000001"}),observation(),{now:now+1000}).status,"scheduled");
  assert.equal(assess(envelope(),observation({checkedAt:now-30000})).status,"unavailable");
  assert.equal(assess(envelope(),observation({block:{...observation().block,timestamp:1799999970n}})).status,"unavailable");
  assert.equal(assess(envelope(),observation({checkedAt:now+1})).status,"unavailable");
});
test("private quotes are executable only by their named borrower; owners cannot self-borrow",()=>{
  const e=envelope({borrower:addr(2)});
  assert.equal(assess(e).borrowerEligible,false);
  assert.equal(assess(e,observation(),{account:addr(2)}).borrowerEligible,true);
  assert.equal(assess(e,observation(),{account:addr(3)}).borrowerEligible,false);
  assert.equal(assess(envelope(),observation(),{account:signer.address}).borrowerEligible,false);
  assert.equal(assess(envelope({borrower:signer.address})).status,"invalid");
});
test("directory requires rates above policy before rounding; contract checks actual rounded draw",()=>{
  assert.equal(assess(envelope({interestForCapacity:"2999999"})).status,"invalid");
  assert.equal(assess(envelope({collateralForCapacity:"299999999999999999999"})).status,"invalid");
  assert.equal(assess(envelope({duration:"2678400"})).status,"invalid");
});
test("multiple quote nonces share cash; duplicate payloads and private quotes cannot inflate it",()=>{
  const a=row(),b=row(envelope({nonce:"2"}));
  assert.equal(summary([a,a]).capacity,300_000000n);
  assert.equal(summary([a,b]).capacity,500_000000n);
  assert.equal(summary([a,row(envelope({nonce:"3",borrower:addr(2)}))]).capacity,300_000000n);
  const defaults=observation({activePrincipal:100_000000n,unresolvedDefaultPrincipal:300_000000n});
  assert.equal(summary([row(envelope(),defaults),row(envelope({nonce:"2"}),defaults)]).capacity,100_000000n);
});
test("conflicting payloads, forks, accounting observations and malformed state fail closed",()=>{
  const a=row();
  for(const b of [row(envelope({interestForCapacity:"31000000"})),row(envelope(),observation({feeBps:2000n})),
    row(envelope(),observation({block:{...observation().block,hash:`0x${"b".repeat(64)}`}})),
    row(envelope(),observation({use:{digest:quoteDigest(envelope()),filled:1n,cancelled:false}}))]) {
    const result=summary([a,b]);assert.equal(result.status,"unavailable");assert.equal(result.capacity,0n);
  }
  for(const s of [undefined,{}, {activePrincipal:1n},observation({limits:{}}),observation({healthy:"true"}),observation({idleCash:undefined})]) {
    assert.equal(assessQuote(envelope(),s,{now}).capacity,0n);
    assert.equal(summary([{envelope:envelope(),observation:s}]).capacity,0n);
  }
});
test("signature verification calls the facility view at the pinned block and propagates uncertainty",async()=>{
  const e=envelope();e.signature=await signer.signTypedData(quoteTypedData(e));
  let response=true;
  const client={readContract:async args=>{
    assert.equal(args.address,e.facility);assert.equal(args.functionName,"isValidQuoteSignature");
    assert.equal(args.blockNumber,42n);assert.equal(args.args[1],e.signature);return response;
  }};
  assert.equal(await verifyFacilitySignature(client,e,{number:42n}),true);
  response=false;assert.equal(await verifyFacilitySignature(client,e,{number:42n}),false);
  response=undefined;await assert.rejects(verifyFacilitySignature(client,e,{number:42n}),/unavailable/);
  client.readContract=async()=>{throw new Error("RPC timed out");};
  await assert.rejects(verifyFacilitySignature(client,e,{number:42n}),/RPC timed out/);
});
