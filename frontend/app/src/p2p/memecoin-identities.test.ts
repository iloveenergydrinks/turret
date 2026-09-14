import { describe, expect, it } from "vitest";
import identities from "./memecoin-token-identities.json";
import { validateDeployment, type Deployment } from "./client";
const base: Deployment = { version: 3, chainId: 4663, chainName: "Robinhood", rpcUrl: "/api/rpc", address: "0x1111111111111111111111111111111111111111", loanToken: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168", collateralToken: identities[0].address as `0x${string}`, loanSymbol: "USDG", collateralSymbol: identities[0].symbol, loanDecimals: 6, collateralDecimals: 18, runtimeHash: `0x${"a".repeat(64)}`, vaultImplementation: "0x2222222222222222222222222222222222222222", vaultImplementationHash: `0x${"b".repeat(64)}`, startBlock: "1" };
describe("reviewed memecoin identities", () => {
  it.each(identities)("accepts the reviewed address for $symbol", token => {
    expect(validateDeployment({ ...base, collateralSymbol: token.symbol, collateralToken: token.address }, "turret.capital").collateralToken).toBe(token.address);
  });
  it("rejects a known ticker bound to another token", () => {
    expect(() => validateDeployment({ ...base, collateralToken: identities[1].address }, "turret.capital")).toThrow(/reviewed token identities/);
  });
  it("rejects unreviewed collateral and the wrong loan currency", () => {
    expect(() => validateDeployment({ ...base, collateralSymbol: "RANDOM" }, "turret.capital")).toThrow(/reviewed token identities/);
    expect(() => validateDeployment({ ...base, loanToken: "0x3333333333333333333333333333333333333333" }, "turret.capital")).toThrow(/reviewed token identities/);
  });
});
