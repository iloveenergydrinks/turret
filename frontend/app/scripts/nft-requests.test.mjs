import test from "node:test";
import assert from "node:assert/strict";
import { keccak256 } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createNFTRequests } from "./nft-requests.mjs";
import { nftRequestActionMessage } from "../src/nft/requests-shared.mjs";
import { requestActionMessage } from "../src/p2p/requests-shared.mjs";

// Synthetic signing keys used only by this in-memory fixture.
const borrower = privateKeyToAccount(`0x${"11".repeat(32)}`);
const lender = privateKeyToAccount(`0x${"22".repeat(32)}`);
const collection = `0x${"33".repeat(20)}`;
const market = { address: `0x${"44".repeat(20)}`, loanToken: `0x${"55".repeat(20)}`,
  collections: [collection], chainId: 31337, version: 1, runtimeHash: keccak256("0x6000") };
const origin = "http://localhost:3000";
let nonce = 1;
function fixture() {
  let saved;
  const time = 2_000_000_000;
  const terms = { principal: "25000000", collection, tokenId: "0", interest: "1000000", durationDays: 30, expiresAt: time + 86400 };
  const state = { holder: borrower.address, allowed: true, paused: false, badCode: false, reorg: false, chain: 31337 };
  const client = {
    getChainId: async () => state.chain,
    getBlock: async args => ({ number: 1n, timestamp: BigInt(time), hash: `0x${args && state.reorg ? "77".repeat(32) : "66".repeat(32)}` }),
    getCode: async () => state.badCode ? "0x6001" : "0x6000",
    readContract: async ({ functionName }) => functionName === "accountOffers" ? [[],0n] : ({ loanToken: market.loanToken, ownerOf: state.holder,
      allowedCollections: state.allowed, newLoansPaused: state.paused })[functionName],
  };
  const options = { markets: [market], client, origin, now: () => time,
    persistence: { read: async () => saved, write: async value => { saved = structuredClone(value); } } };
  const service = createNFTRequests(options);
  const sign = async (account, action = { action: "publish", terms }) => {
    const envelope = { version: 1, origin, chainId: 31337, market: market.address, account: account.address,
      issuedAt: time, validUntil: time + 300, nonce: `0x${(nonce++).toString(16).padStart(64, "0")}`, ...action };
    return { envelope, signature: await account.signMessage({ message: nftRequestActionMessage(envelope) }) };
  };
  const submit = async (account, action) => service.submit(await sign(account, action));
  return { service, options, state, terms, sign, submit };
}

test("NFT ownership is required and token ID zero is valid", async () => {
  const f = fixture();
  await assert.rejects(f.submit(lender), /no longer owns/);
  const result = await f.submit(borrower);
  assert.equal(result.request.terms.tokenId, "0");
  await assert.rejects(f.submit(borrower), /already exists/);
});
test("signed token identity cannot be tampered with or substituted by a proposer", async () => {
  const f = fixture(); const signed = await f.sign(borrower);
  await assert.rejects(f.service.submit({ ...signed, envelope: { ...signed.envelope, terms: { ...f.terms, tokenId: "1" } } }), /signature/);
  const { request } = await f.service.submit(signed);
  await assert.rejects(f.submit(lender, { action: "propose", requestId: request.id, revision: 1, terms: { ...f.terms, tokenId: "1" } }), /cannot replace/);
});
test("stock request signatures cannot be replayed on the NFT board", async () => {
  const f = fixture(); const signed = await f.sign(borrower);
  const signature = await borrower.signMessage({ message: requestActionMessage(signed.envelope) });
  await assert.rejects(f.service.submit({ ...signed, signature }), /signature/);
});
test("signature replay protection survives a service restart", async () => {
  const f = fixture(); const signed = await f.sign(borrower);
  await f.service.submit(signed);
  await assert.rejects(createNFTRequests(f.options).submit(signed), /already used/);
});
test("wrong chain, runtime, removal, pause and reorg fail closed", async () => {
  for (const [key, value, error] of [["chain", 4663, /wrong chain/], ["badCode", true, /identity/],
    ["allowed", false, /paused/], ["paused", true, /paused/], ["reorg", true, /chain changed/]]) {
    const f = fixture(); f.state[key] = value;
    await assert.rejects(f.submit(borrower), error);
    assert.equal((await f.service.list()).requests.length, 0);
  }
});
test("ownership is rechecked before proposal and agreement", async () => {
  const f = fixture(); let row = (await f.submit(borrower)).request;
  const action = { action: "propose", requestId: row.id, revision: row.revision, terms: f.terms };
  f.state.holder = lender.address;
  await assert.rejects(f.submit(lender, action), /no longer owns/);
  f.state.holder = borrower.address;
  row = (await f.submit(lender, action)).request;
  f.state.holder = lender.address;
  await assert.rejects(f.submit(borrower, { action: "accept", requestId: row.id, revision: row.revision, proposalId: row.proposals[0].id }), /no longer owns/);
});
test("removal does not prevent signed listing cancellation", async () => {
  const f = fixture(); const row = (await f.submit(borrower)).request;
  f.state.allowed = false;
  await f.submit(borrower, { action: "cancel", requestId: row.id, revision: row.revision });
  assert.equal((await f.service.list()).requests.length, 0);
});
test("invalid numeric identities, hidden fields and cross-origin actions are rejected", async () => {
  const f = fixture();
  for (const tokenId of ["-1", "01", "1.1", (1n << 256n).toString()]) {
    await assert.rejects(f.submit(borrower, { action: "publish", terms: { ...f.terms, tokenId } }), /exact positive/);
  }
  await assert.rejects(f.submit(borrower, { action: "publish", terms: f.terms, origin: "https://evil.example" }), /Invalid or expired/);
  await assert.rejects(f.submit(borrower, { action: "publish", terms: f.terms, approval: true }), /signed fields/);
});

test("v2 listing signatures show human USDG units and bind the complete deal", async () => {
  const f = fixture(); const signed = await f.sign(borrower,{action:"publish",version:2,terms:f.terms});
  const message = nftRequestActionMessage(signed.envelope);
  assert.match(message,/Borrower receives: 25 USDG/); assert.match(message,/Full repayment: 26 USDG/);
  assert.match(message,/Interest included: 1 USDG/); assert.match(message,/Token ID: #0/);
  for (const terms of [{...f.terms,principal:"26000000"},{...f.terms,interest:"2000000"},{...f.terms,durationDays:3}])
    await assert.rejects(f.service.submit({...signed,envelope:{...signed.envelope,terms}}),/signature/);
  const row = (await f.service.submit(signed)).request;
  await f.submit(lender,{action:"propose",requestId:row.id,revision:1,terms:f.terms});
  const removed = await f.submit(borrower,{action:"cancel",version:2,requestId:row.id,revision:1,terms:f.terms});
  assert.equal(removed.request.status,"cancelled","another lender's proposal does not invalidate removing your unchanged listing");
});
test("v2 cancellation cannot substitute the listing terms", async () => {
  const f = fixture();const row = (await f.submit(borrower)).request;
  await assert.rejects(f.submit(borrower,{action:"cancel",version:2,requestId:row.id,revision:1,terms:{...f.terms,principal:"1"}}),/terms do not match/);
});
test("archived listings are pruned before capacity is enforced; active records remain", async () => {
  const f = fixture(); const row = (await f.submit(borrower)).request;
  let saved = await f.options.persistence.read();
  saved.requests[0].terms.expiresAt = 2_000_000_000-31*86400;
  const persistence = {read:async()=>saved,write:async value=>{saved=value;}};
  const service = createNFTRequests({...f.options,persistence,maxRecords:1});
  const created=await service.submit(await f.sign(borrower));
  assert.notEqual(created.request.id,row.id);assert.equal(saved.requests.length,1);
});
