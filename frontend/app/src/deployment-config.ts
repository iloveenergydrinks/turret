import type { CollateralSymbol } from "@/src/types";

const COLLATERAL_SYMBOLS = new Set<string>([
  "AAPL",
  "AMZN",
  "AVGO",
  "ETH",
  "GOOGL",
  "LLY",
  "META",
  "MSFT",
  "MU",
  "NVDA",
  "RETH",
  "TSLA",
  "WSTETH",
]);

function isCollateralSymbol(value: string): value is CollateralSymbol {
  return COLLATERAL_SYMBOLS.has(value);
}

type PublicDeploymentEnv = Partial<
  Record<
    | `NEXT_PUBLIC_COLL_${number}_TOKEN_ID`
    | "NEXT_PUBLIC_ENABLE_LEVERAGE"
    | "NEXT_PUBLIC_ENABLE_STAKING"
    | "NEXT_PUBLIC_SBOLD",
    string
  >
>;

const publicDeploymentEnv: PublicDeploymentEnv = {
  NEXT_PUBLIC_COLL_0_TOKEN_ID: process.env.NEXT_PUBLIC_COLL_0_TOKEN_ID,
  NEXT_PUBLIC_COLL_1_TOKEN_ID: process.env.NEXT_PUBLIC_COLL_1_TOKEN_ID,
  NEXT_PUBLIC_COLL_2_TOKEN_ID: process.env.NEXT_PUBLIC_COLL_2_TOKEN_ID,
  NEXT_PUBLIC_COLL_3_TOKEN_ID: process.env.NEXT_PUBLIC_COLL_3_TOKEN_ID,
  NEXT_PUBLIC_COLL_4_TOKEN_ID: process.env.NEXT_PUBLIC_COLL_4_TOKEN_ID,
  NEXT_PUBLIC_COLL_5_TOKEN_ID: process.env.NEXT_PUBLIC_COLL_5_TOKEN_ID,
  NEXT_PUBLIC_COLL_6_TOKEN_ID: process.env.NEXT_PUBLIC_COLL_6_TOKEN_ID,
  NEXT_PUBLIC_COLL_7_TOKEN_ID: process.env.NEXT_PUBLIC_COLL_7_TOKEN_ID,
  NEXT_PUBLIC_COLL_8_TOKEN_ID: process.env.NEXT_PUBLIC_COLL_8_TOKEN_ID,
  NEXT_PUBLIC_COLL_9_TOKEN_ID: process.env.NEXT_PUBLIC_COLL_9_TOKEN_ID,
  NEXT_PUBLIC_ENABLE_LEVERAGE: process.env.NEXT_PUBLIC_ENABLE_LEVERAGE,
  NEXT_PUBLIC_ENABLE_STAKING: process.env.NEXT_PUBLIC_ENABLE_STAKING,
  NEXT_PUBLIC_SBOLD: process.env.NEXT_PUBLIC_SBOLD,
};

export function getConfiguredCollateralSymbols(
  env: PublicDeploymentEnv = publicDeploymentEnv,
): CollateralSymbol[] {
  const symbols: CollateralSymbol[] = [];

  for (let index = 0; index < 10; index++) {
    const value = env[`NEXT_PUBLIC_COLL_${index}_TOKEN_ID`];
    if (!value) break;
    if (!isCollateralSymbol(value)) {
      throw new Error(`Invalid collateral symbol in branch ${index}: ${value}`);
    }
    if (symbols.includes(value)) {
      throw new Error(`Duplicate collateral symbol in branch ${index}: ${value}`);
    }
    symbols.push(value);
  }

  return symbols;
}

export function getBorrowStaticParams(
  env: PublicDeploymentEnv = publicDeploymentEnv,
) {
  return getConfiguredCollateralSymbols(env).map((symbol) => ({
    collateral: symbol.toLowerCase(),
  }));
}

export function getEarnPoolStaticParams(
  env: PublicDeploymentEnv = publicDeploymentEnv,
) {
  return [
    ...getConfiguredCollateralSymbols(env).map((symbol) => ({
      pool: symbol.toLowerCase(),
    })),
    ...(env.NEXT_PUBLIC_SBOLD ? [{ pool: "sbold" }] : []),
  ];
}

function envFlag(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined || value.trim() === "") return defaultValue;
  return ["1", "true", "yes"].includes(value.trim().toLowerCase());
}

export function getDeploymentFeatures(
  env: PublicDeploymentEnv = publicDeploymentEnv,
) {
  return {
    leverage: envFlag(env.NEXT_PUBLIC_ENABLE_LEVERAGE, true),
    staking: envFlag(env.NEXT_PUBLIC_ENABLE_STAKING, true),
  };
}

export const DEPLOYMENT_FEATURES = getDeploymentFeatures();
