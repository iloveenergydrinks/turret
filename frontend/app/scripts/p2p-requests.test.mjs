import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { keccak256 } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createP2PRequests, createFileRequestPersistence, createP2PRequestsHandler } from "./p2p-requests.mjs";
import { requestActionMessage } from "../src/p2p/requests-shared.mjs";

const borrower = privateKeyToAccount(`0x${"11".repeat(32)}`);
const lender = privateKeyToAccount(`0x${"22".repeat(32)}`);
const stranger = privateKeyToAccount(`0x${"33".repeat(32)}`);
const origin = "http://localhost:3000";
const market = { address: `0x${"44".repeat(20)}`, loanToken: `0x${"55".repeat(20)}`, collateralToken: `0x${"66".repeat(20)}`,
  chainId: 31337, version: 3, runtimeHash: keccak256("0x6000") };
const block = { number: 10n, hash: `0x${"77".repeat(32)}`, timestamp: 2_000_000_000n };
let nonce = 1;
function fixture(options = {}) {
  let time = Number(block.timestamp), stored;
  const terms = { principal: "25000000", collateral: "2000000000000000000", interest: "1000000", durationDays: 30, expiresAt: time + 86400 };
  const state = { offer: [lender.address, borrower.address, BigInt(terms.principal), BigInt(terms.collateral), BigInt(terms.interest), 30n * 86400n, BigInt(terms.expiresAt), 0n, 1], balance: 25_000000n, badRuntime: false, reorg: false, chain: 31337,
    loanToken: market.loanToken, collateralToken: market.collateralToken, reservedPrincipal: 50_000000n, totalCredits: 5_000000n };
  const client = { getChainId: async () => state.chain, getBlock: async args => ({ ...block, timestamp: BigInt(time), hash: args && state.reorg ? `0x${"99".repeat(32)}` : block.hash }),
    getCode: async () => state.badRuntime ? "0x6001" : "0x6000", readContract: async ({ functionName }) => ({
      loanToken: state.loanToken, collateralToken: state.collateralToken, offers: state.offer, vaults: `0x${"88".repeat(20)}`, balanceOf: state.balance,
      reservedPrincipal: state.reservedPrincipal, totalCredits: state.totalCredits,
    })[functionName] };
  const persistence = options.persistence ?? { read: async () => stored, write: async value => { stored = structuredClone(value); } };
  const serviceOptions = { markets: [market], client, persistence, origin, now: () => time, ...options };
  const service = createP2PRequests(serviceOptions);
  const signed = async (account, action, overrides = {}) => {
    const envelope = { version: 1, origin: serviceOptions.origin, chainId: 31337, market: market.address, account: account.address,
      action: "publish", terms, issuedAt: time, validUntil: time + 300, nonce: `0x${(nonce++).toString(16).padStart(64, "0")}`, ...action, ...overrides };
    if (action.action !== "publish") delete envelope.terms;
    if (action.terms) envelope.terms = action.terms;
    return { envelope, signature: await account.signMessage({ message: requestActionMessage(envelope) }) };
  };
  const submit = async (account, action, overrides) => service.submit(await signed(account, action, overrides));
  const setup = async () => {
    const { request } = await submit(borrower, { action: "publish" });
    const result = await submit(lender, { action: "propose", requestId: request.id, revision: request.revision, terms });
    return result.request;
  };
  return { service, serviceOptions, terms, state, signed, submit, setup, advance: seconds => { time += seconds; } };
}

test("signed request → counteroffer → borrower agreement, no chain transaction needed", async () => {
  const f = fixture(); let row = await f.setup();
  assert.equal(row.status, "open"); assert.equal(row.proposals[0].fundedOffer, null);
  row = (await f.submit(borrower, { action: "accept", requestId: row.id, revision: row.revision, proposalId: row.proposals[0].id })).request;
  assert.equal(row.status, "agreed"); assert.equal(row.acceptedProposalId, row.proposals[0].id);
  assert.equal((await f.service.list({ account: lender.address })).requests[0].id, row.id);
});

test("rejects forged, altered, cross-domain, cross-chain, expired and replayed signatures", async () => {
  const f = fixture();
  const signed = await f.signed(borrower, { action: "publish" });
  await assert.rejects(f.service.submit({ ...signed, signature: await stranger.signMessage({ message: requestActionMessage(signed.envelope) }) }), /signature/);
  await assert.rejects(f.service.submit({ ...signed, envelope: { ...signed.envelope, terms: { ...f.terms, principal: "2" } } }), /signature/);
  await assert.rejects(f.submit(borrower, { action: "publish" }, { origin: "https://another.example" }), /Invalid or expired/);
  await assert.rejects(f.submit(borrower, { action: "publish" }, { chainId: 4663 }), /registered/);
  await assert.rejects(f.submit(borrower, { action: "publish" }, { validUntil: Number(block.timestamp) }), /expired/);
  await f.service.submit(signed);
  await assert.rejects(f.service.submit(signed), /already used/);
  const restarted = createP2PRequests(f.serviceOptions);
  await assert.rejects(restarted.submit(signed), /already used/);
});

test("exact action schema and numeric bounds reject hidden fields, zero, overflow and imprecise units", async () => {
  const f = fixture();
  for (const terms of [ { ...f.terms, principal: "0" }, { ...f.terms, collateral: "1.1" }, { ...f.terms, interest: (1n << 256n).toString() },
    { ...f.terms, durationDays: 1.5 }, { ...f.terms, durationDays: Number.MAX_SAFE_INTEGER }, { ...f.terms, expiresAt: Number(block.timestamp) + 31 * 86400 } ]) {
    await assert.rejects(f.submit(borrower, { action: "publish", terms }), /exact positive|whole-day/);
  }
  await assert.rejects(f.submit(borrower, { action: "publish" }, { arbitrary: "0xdeadbeef" }), /signed fields/);
  await assert.rejects(f.submit(borrower, { action: "publish" }, { market: stranger.address }), /registered/);
});

test("only correct parties may propose, agree, cancel; revisions reject stale consent", async () => {
  const f = fixture(); let row = await f.setup();
  await assert.rejects(f.submit(borrower, { action: "propose", requestId: row.id, revision: row.revision, terms: f.terms }), /lender wallet/);
  await assert.rejects(f.submit(lender, { action: "accept", requestId: row.id, revision: row.revision, proposalId: row.proposals[0].id }), /Only the borrower/);
  await assert.rejects(f.submit(stranger, { action: "cancel", requestId: row.id, revision: row.revision }), /Only the borrower/);
  await assert.rejects(f.submit(stranger, { action: "cancelProposal", requestId: row.id, revision: row.revision, proposalId: row.proposals[0].id }), /Only its lender/);
  await assert.rejects(f.submit(borrower, { action: "accept", requestId: row.id, revision: 1, proposalId: row.proposals[0].id }), /request changed/);
  row = (await f.submit(borrower, { action: "accept", requestId: row.id, revision: row.revision, proposalId: row.proposals[0].id })).request;
  row = (await f.submit(lender, { action: "cancelProposal", requestId: row.id, revision: row.revision, proposalId: row.proposals[0].id })).request;
  assert.equal(row.status, "open"); assert.equal(row.acceptedProposalId, null);
  await assert.rejects(f.submit(borrower, { action: "accept", requestId: row.id, revision: row.revision, proposalId: row.proposals[0].id }), /no longer available/);
});

test("expiry and cancellation remove public requests but keep the parties' history", async () => {
  const f = fixture(); let row = await f.setup();
  row = (await f.submit(borrower, { action: "cancel", requestId: row.id, revision: row.revision })).request;
  assert.equal((await f.service.list()).requests.length, 0);
  assert.equal((await f.service.list({ account: borrower.address })).requests.length, 1);
  await assert.rejects(f.submit(lender, { action: "propose", requestId: row.id, revision: row.revision, terms: f.terms }), /cancelled/);
  const other = fixture(); const expired = await other.setup(); other.advance(86401);
  assert.equal((await other.service.list()).requests.length, 0);
  assert.equal((await other.service.list({ requestId: expired.id })).requests.length, 1);
});

test("funded link verifies parties, terms, runtime, backing, chain and canonical block", async () => {
  const f = fixture(); let row = await f.setup();
  const bind = () => f.submit(lender, { action: "bind", requestId: row.id, revision: row.revision, proposalId: row.proposals[0].id, offerId: "1" });
  await assert.rejects(f.submit(stranger, { action: "bind", requestId: row.id, revision: row.revision, proposalId: row.proposals[0].id, offerId: "1" }), /named parties/);
  f.state.offer[1] = stranger.address; await assert.rejects(bind(), /exact proposed terms/); f.state.offer[1] = borrower.address;
  f.state.offer[2]++; await assert.rejects(bind(), /exact proposed terms/); f.state.offer[2]--;
  f.state.badRuntime = true; await assert.rejects(bind(), /identity/); f.state.badRuntime = false;
  f.state.balance = 1n; await assert.rejects(bind(), /fully backed/); f.state.balance = 25_000000n;
  f.state.chain = 4663; await assert.rejects(bind(), /wrong chain/); f.state.chain = 31337;
  f.state.reorg = true; await assert.rejects(bind(), /chain changed/); f.state.reorg = false;
  row = (await bind()).request;
  assert.equal(row.proposals[0].fundedOffer.id, "1");
  assert.equal(row.proposals[0].fundedOffer.status, "open");
  f.state.offer[8] = 2;
  row = (await bind()).request;
  assert.equal(row.proposals[0].fundedOffer.status, "active");
});

test("atomic durable persistence survives service restart and does not publish a failed save", async () => {
  const directory = await mkdtemp(join(tmpdir(), "p2p-requests-"));
  try {
    const persistence = createFileRequestPersistence(directory); const f = fixture({ persistence }); const row = await f.setup();
    const restarted = createP2PRequests(f.serviceOptions);
    assert.equal((await restarted.list()).requests[0].id, row.id);
    const failed = fixture({ persistence: { read: async () => undefined, write: async () => { throw new Error("disk full"); } } });
    await assert.rejects(failed.submit(borrower, { action: "publish" }), /disk full/);
    assert.equal((await failed.service.list()).requests.length, 0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("concurrent signed proposals serialize and reject the stale revision", async () => {
  const f = fixture(); const { request: row } = await f.submit(borrower, { action: "publish" });
  const actions = await Promise.all([f.signed(lender, { action: "propose", requestId: row.id, revision: 1, terms: f.terms }), f.signed(stranger, { action: "propose", requestId: row.id, revision: 1, terms: f.terms })]);
  const result = await Promise.allSettled(actions.map(action => f.service.submit(action)));
  assert.equal(result.filter(item => item.status === "fulfilled").length, 1);
  assert.equal((await f.service.list()).requests[0].proposals.length, 1);
});

test("signature validation rejects a wrong RPC chain and rechecks expiry after verification", async () => {
  let verified = false;
  const f = fixture({ verify: async () => { verified = true; return true; } }); f.state.chain = 4663;
  await assert.rejects(f.submit(borrower, { action: "publish" }), /wrong chain/);
  assert.equal(verified, false);
  const delayed = fixture({ verify: async () => { delayed.advance(301); return true; } });
  await assert.rejects(delayed.submit(borrower, { action: "publish" }), /expired/);
  assert.equal((await delayed.service.list()).requests.length, 0);
});

test("a committed rename followed by fsync failure reloads durable nonce protection", async () => {
  let saved;
  const f = fixture({ persistence: { read: async () => saved, write: async value => { saved = structuredClone(value); throw new Error("directory fsync failed"); } } });
  const signed = await f.signed(borrower, { action: "publish" });
  await assert.rejects(f.service.submit(signed), /fsync failed/);
  assert.equal((await f.service.list()).requests.length, 1);
  await assert.rejects(f.service.submit(signed), /already used/);
  assert.equal((await f.service.list()).requests.length, 1);
});

test("linked offers can refresh to cancelled or expired without pretending the old open state is current", async () => {
  const f = fixture(); let row = await f.setup();
  const bind = async () => { row = (await f.submit(lender, { action: "bind", requestId: row.id, revision: row.revision, proposalId: row.proposals[0].id, offerId: "1" })).request; };
  await bind(); f.state.offer[8] = 5; await bind(); assert.equal(row.proposals[0].fundedOffer.status, "cancelled");
  f.state.offer[8] = 6; await bind(); assert.equal(row.proposals[0].fundedOffer.status, "expired");
  // An open offer which nobody has explicitly expired is already unacceptably late.
  f.state.offer[8] = 1; f.advance(86401); await bind(); assert.equal(row.proposals[0].fundedOffer.status, "expired");
});

test("V2 links verify all shared USDG liabilities and immutable token identities", async () => {
  const f = fixture({ markets: [{ ...market, version: 2 }] }); const row = await f.setup();
  const bind = () => f.submit(lender, { action: "bind", requestId: row.id, revision: row.revision, proposalId: row.proposals[0].id, offerId: "1" });
  await assert.rejects(bind(), /fully backed/);
  f.state.balance = 55_000000n; f.state.loanToken = stranger.address;
  await assert.rejects(bind(), /identity/);
  f.state.loanToken = market.loanToken; f.state.collateralToken = stranger.address;
  await assert.rejects(bind(), /identity/);
  f.state.collateralToken = market.collateralToken;
  assert.equal((await bind()).request.proposals[0].fundedOffer.status, "open");
});

test("HTTP endpoint rejects cross-origin/oversize writes and reports errors without false empty results", async () => {
  const f = fixture(); const handler = createP2PRequestsHandler(f.service);
  const server = createServer((req, res) => { void handler(req, res); });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}/api/p2p/requests`;
  try {
    const signed = await f.signed(borrower, { action: "publish" });
    assert.equal((await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", Origin: "https://attacker.example" }, body: JSON.stringify(signed) })).status, 403);
    assert.equal((await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", Origin: origin }, body: JSON.stringify(signed) })).status, 200);
    assert.equal((await (await fetch(url)).json()).requests.length, 1);
    assert.equal((await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", Origin: origin }, body: "x".repeat(17000) })).status, 413);
    assert.equal((await fetch(`${url}?market=${stranger.address}`)).status, 400);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
