// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Deployment } from "./client";
import { publishedProposalFunding, requestFundingDraft, validateRequestFunding, type BorrowerRequest, type RequestFundingDraft } from "./requests";

const NOW = 2_000_000_000;
const BORROWER = "0x1111111111111111111111111111111111111111";
const LENDER = "0x2222222222222222222222222222222222222222";
const MARKET = "0x3333333333333333333333333333333333333333";
const market: Deployment = { address: MARKET, chainId: 31337, version: 3, chainName: "Local requests", rpcUrl: "/api/p2p-rpc",
  loanToken: "0x6666666666666666666666666666666666666666", collateralToken: "0x7777777777777777777777777777777777777777",
  loanSymbol: "USDG", collateralSymbol: "SLV", loanDecimals: 6, collateralDecimals: 18, runtimeHash: `0x${"88".repeat(32)}`, startBlock: "1" };
const terms = { principal: "25000000", collateral: "2000000000000000000", interest: "1000000", durationDays: 30, expiresAt: NOW + 86400 };
let request: BorrowerRequest;
let draft: RequestFundingDraft;
beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(NOW * 1000);
  request = { id: "11111111-1111-4111-8111-111111111111", sequence: 1, revision: 2, market: MARKET, chainId: 31337, borrower: BORROWER,
    terms, createdAt: NOW, status: "open", acceptedProposalId: null, proposals: [{ id: "22222222-2222-4222-8222-222222222222", lender: LENDER,
      terms: { ...terms }, createdAt: NOW, cancelled: false, fundedOffer: null }] };
  draft = requestFundingDraft(request, request.proposals[0]!, market);
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ schemaVersion: 1, origin: window.location.origin,
    now: NOW, requests: [request], nextCursor: null }) })));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("request funding preflight", () => {
  it("preserves exact agreed amounts after re-reading the live listing", async () => {
    const result = await validateRequestFunding(draft, LENDER);
    expect(result.id).toBe(request.id);
    expect(draft.principal).toBe(25_000000n);
    expect(draft.collateral).toBe(2n * 10n ** 18n);
  });
  it.each(["request cancellation", "proposal cancellation", "expiry", "already funded", "lender changed"])("blocks %s before token funding", async scenario => {
    if (scenario === "request cancellation") request.status = "cancelled";
    if (scenario === "proposal cancellation") request.proposals[0]!.cancelled = true;
    if (scenario === "expiry") request.proposals[0]!.terms.expiresAt = NOW - 1;
    if (scenario === "already funded") request.proposals[0]!.fundedOffer = { id: "1", status: "open", blockNumber: "10", blockHash: `0x${"44".repeat(32)}`, checkedAt: NOW };
    if (scenario === "lender changed") request.proposals[0]!.lender = "0x5555555555555555555555555555555555555555";
    await expect(validateRequestFunding(draft, LENDER)).rejects.toThrow(/changed|cancelled|funded/);
  });
  it("blocks draft edits which would no longer bind to the exact signed proposal", async () => {
    await expect(validateRequestFunding(draft, LENDER, { ...draft, interest: 2_000000n })).rejects.toThrow("differ from your signed proposal");
    await expect(validateRequestFunding(draft, LENDER, { ...draft, borrower: LENDER })).rejects.toThrow("differ from your signed proposal");
  });
  it("rejects a zero-address borrower instead of creating a public offer", async () => {
    request.borrower = "0x0000000000000000000000000000000000000000";
    await expect(validateRequestFunding(draft, LENDER)).rejects.toThrow("invalid listing");
  });
  it("does not hide an unavailable board behind a funding action", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("Request board unavailable"); }));
    await expect(validateRequestFunding(draft, LENDER)).rejects.toThrow("unavailable");
  });
});

describe("published proposal funding", () => {
  it("allows immediate funding before borrower agreement", () => {
    expect(publishedProposalFunding({...request, revision: 1, proposals: []}, request, market, LENDER, terms)).toEqual(draft);
  });
  it.each(["revision", "borrower", "market", "chain", "duplicate", "cancelled", "old proposal"])("rejects unsafe saved result: %s", scenario => {
    const before: BorrowerRequest = {...request, revision: 1, proposals: []};
    if (scenario === "revision") request.revision = 1;
    if (scenario === "borrower") request.borrower = LENDER;
    if (scenario === "market") request.market = LENDER;
    if (scenario === "chain") request.chainId = 1;
    if (scenario === "duplicate") request.proposals.push({...request.proposals[0]!, id:"another"});
    if (scenario === "cancelled") request.proposals[0]!.cancelled = true;
    if (scenario === "old proposal") before.proposals = request.proposals;
    expect(() => publishedProposalFunding(before, request, market, LENDER, terms)).toThrow();
  });
});
