import { describe, expect, test } from "vitest";
import {
  getBorrowStaticParams,
  getConfiguredCollateralSymbols,
  getDeploymentFeatures,
  getEarnPoolStaticParams,
} from "./deployment-config";

const stockEnv = {
  NEXT_PUBLIC_COLL_0_TOKEN_ID: "AAPL",
  NEXT_PUBLIC_COLL_1_TOKEN_ID: "MSFT",
  NEXT_PUBLIC_COLL_2_TOKEN_ID: "GOOGL",
  NEXT_PUBLIC_COLL_3_TOKEN_ID: "AMZN",
  NEXT_PUBLIC_COLL_4_TOKEN_ID: "META",
  NEXT_PUBLIC_COLL_5_TOKEN_ID: "NVDA",
  NEXT_PUBLIC_COLL_6_TOKEN_ID: "AVGO",
  NEXT_PUBLIC_COLL_7_TOKEN_ID: "LLY",
  NEXT_PUBLIC_COLL_8_TOKEN_ID: "MU",
  NEXT_PUBLIC_COLL_9_TOKEN_ID: "TSLA",
} as const;

describe("deployment route configuration", () => {
  test("generates routes for all ten configured Stock Token branches", () => {
    expect(getConfiguredCollateralSymbols(stockEnv)).toEqual([
      "AAPL",
      "MSFT",
      "GOOGL",
      "AMZN",
      "META",
      "NVDA",
      "AVGO",
      "LLY",
      "MU",
      "TSLA",
    ]);
    expect(getBorrowStaticParams(stockEnv)).toEqual([
      { collateral: "aapl" },
      { collateral: "msft" },
      { collateral: "googl" },
      { collateral: "amzn" },
      { collateral: "meta" },
      { collateral: "nvda" },
      { collateral: "avgo" },
      { collateral: "lly" },
      { collateral: "mu" },
      { collateral: "tsla" },
    ]);
  });

  test("adds the sBOLD pool only when it is configured", () => {
    expect(getEarnPoolStaticParams(stockEnv)).toHaveLength(10);
    expect(getEarnPoolStaticParams({
      ...stockEnv,
      NEXT_PUBLIC_SBOLD: "0x0000000000000000000000000000000000000001",
    })).toContainEqual({ pool: "sbold" });
  });

  test("rejects invalid and duplicate collateral configuration", () => {
    expect(() =>
      getConfiguredCollateralSymbols({
        NEXT_PUBLIC_COLL_0_TOKEN_ID: "SPY",
      })
    ).toThrow("Invalid collateral symbol in branch 0: SPY");
    expect(() =>
      getConfiguredCollateralSymbols({
        NEXT_PUBLIC_COLL_0_TOKEN_ID: "AAPL",
        NEXT_PUBLIC_COLL_1_TOKEN_ID: "AAPL",
      })
    ).toThrow("Duplicate collateral symbol in branch 1: AAPL");
  });

  test("keeps upstream features enabled unless the deployment disables them", () => {
    expect(getDeploymentFeatures({})).toEqual({ leverage: true, staking: true });
    expect(getDeploymentFeatures({
      NEXT_PUBLIC_ENABLE_LEVERAGE: "false",
      NEXT_PUBLIC_ENABLE_STAKING: "0",
    })).toEqual({ leverage: false, staking: false });
  });
});
