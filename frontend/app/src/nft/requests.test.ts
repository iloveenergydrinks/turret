import { describe, expect, it } from "vitest";
import { validateNFTRequest, type NFTRequest } from "./requests";
const request = (): NFTRequest => ({ id: "11111111-1111-4111-8111-111111111111", revision: 1,
  borrower: "0x1111111111111111111111111111111111111111", status: "open", acceptedProposalId: null, proposals: [],
  terms: { collection: "0x2222222222222222222222222222222222222222", tokenId: "0", principal: "1000000", interest: "200000", durationDays: 30, expiresAt: 1800000000 } });
describe("NFT request response validation", () => {
  it("allows token zero and expired requests to be displayed without reauthorizing them", () => {
    expect(validateNFTRequest(request()).terms.tokenId).toBe("0");
  });
  it("rejects invalid financial values rather than rendering them as loan terms", () => {
    for (const change of [{ principal: "-1" }, { principal: "1e6" }, { interest: String(2n ** 256n) }, { tokenId: "1.5" }, { durationDays: 0.5 }, { expiresAt: Number.MAX_SAFE_INTEGER }]) {
      const row = request(); Object.assign(row.terms, change); expect(() => validateNFTRequest(row)).toThrow();
    }
  });
  it("rejects proposals that substitute a different NFT or invented accepted IDs", () => {
    const row = request();
    row.acceptedProposalId = "not-present"; expect(() => validateNFTRequest(row)).toThrow(); row.acceptedProposalId = null;
    row.proposals = [{ id: "22222222-2222-4222-8222-222222222222", lender: "0x3333333333333333333333333333333333333333", cancelled: false, fundedOffer: null, terms: { ...row.terms, tokenId: "1" } }];
    expect(() => validateNFTRequest(row)).toThrow(); row.proposals[0]!.terms.tokenId = "0";
    expect(validateNFTRequest(row).proposals).toHaveLength(1);
  });
});
