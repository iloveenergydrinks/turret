import tokenBold from "./token-icons/bold.svg";
import tokenEth from "./token-icons/eth.svg";
import tokenLqty from "./token-icons/lqty.svg";
import tokenLusd from "./token-icons/lusd.svg";
import tokenReth from "./token-icons/reth.svg";
import tokenSbold from "./token-icons/sbold.svg";
import tokenSteth from "./token-icons/wsteth.svg";
import tokenYbold from "./token-icons/ybold.svg";

// any external token, without a known symbol
export type ExternalToken = {
  icon: string;
  name: string;
  symbol: string;
};

// a token with a known symbol (TokenSymbol)
export type Token = ExternalToken & {
  icon: string;
  name: string;
  symbol: TokenSymbol;
};

export type TokenSymbol =
  | "AAPL"
  | "AMZN"
  | "AVGO"
  | "BOLD"
  | "ETH"
  | "GOOGL"
  | "LQTY"
  | "LUSD"
  | "LLY"
  | "META"
  | "MSFT"
  | "MU"
  | "NVDA"
  | "RETH"
  | "SBOLD"
  | "TSLA"
  | "YBOLD"
  | "WSTETH";

export type CollateralSymbol = TokenSymbol & (
  | "AAPL"
  | "AMZN"
  | "AVGO"
  | "ETH"
  | "GOOGL"
  | "LLY"
  | "META"
  | "MSFT"
  | "MU"
  | "NVDA"
  | "RETH"
  | "TSLA"
  | "WSTETH"
);

export function isTokenSymbol(symbolOrUrl: string): symbolOrUrl is TokenSymbol {
  return (
    symbolOrUrl === "AAPL"
    || symbolOrUrl === "AMZN"
    || symbolOrUrl === "AVGO"
    || symbolOrUrl === "BOLD"
    || symbolOrUrl === "ETH"
    || symbolOrUrl === "GOOGL"
    || symbolOrUrl === "LQTY"
    || symbolOrUrl === "LUSD"
    || symbolOrUrl === "LLY"
    || symbolOrUrl === "META"
    || symbolOrUrl === "MSFT"
    || symbolOrUrl === "MU"
    || symbolOrUrl === "NVDA"
    || symbolOrUrl === "RETH"
    || symbolOrUrl === "SBOLD"
    || symbolOrUrl === "TSLA"
    || symbolOrUrl === "YBOLD"
    || symbolOrUrl === "WSTETH"
  );
}

export function isCollateralSymbol(symbol: string): symbol is CollateralSymbol {
  return symbol === "AAPL"
    || symbol === "AMZN"
    || symbol === "AVGO"
    || symbol === "ETH"
    || symbol === "GOOGL"
    || symbol === "LLY"
    || symbol === "META"
    || symbol === "MSFT"
    || symbol === "MU"
    || symbol === "NVDA"
    || symbol === "RETH"
    || symbol === "TSLA"
    || symbol === "WSTETH";
}

export type CollateralToken = Token & {
  collateralRatio: number;
  symbol: CollateralSymbol;
};

export const LUSD: Token = {
  icon: tokenLusd,
  name: "LUSD",
  symbol: "LUSD" as const,
} as const;

export const BOLD: Token = {
  icon: tokenBold,
  name: "BOLD",
  symbol: "BOLD" as const,
} as const;

export const LQTY: Token = {
  icon: tokenLqty,
  name: "LQTY",
  symbol: "LQTY" as const,
} as const;

export const SBOLD: Token = {
  icon: tokenSbold,
  name: "sBOLD",
  symbol: "SBOLD" as const,
} as const;

export const YBOLD: Token = {
  icon: tokenYbold,
  name: "yBOLD",
  symbol: "YBOLD" as const,
} as const;

export const ETH: CollateralToken = {
  collateralRatio: 1.1,
  icon: tokenEth,
  name: "ETH",
  symbol: "ETH" as const,
} as const;

export const RETH: CollateralToken = {
  collateralRatio: 1.2,
  icon: tokenReth,
  name: "rETH",
  symbol: "RETH" as const,
} as const;

export const WSTETH: CollateralToken = {
  collateralRatio: 1.2,
  icon: tokenSteth,
  name: "wstETH",
  symbol: "WSTETH" as const,
} as const;

function stockToken(symbol: CollateralSymbol, collateralRatio: number): CollateralToken {
  return { collateralRatio, icon: tokenEth, name: symbol, symbol };
}

export const AAPL = stockToken("AAPL", 1.75);
export const MSFT = stockToken("MSFT", 1.75);
export const GOOGL = stockToken("GOOGL", 1.80);
export const AMZN = stockToken("AMZN", 1.85);
export const META = stockToken("META", 1.90);
export const NVDA = stockToken("NVDA", 2.00);
export const AVGO = stockToken("AVGO", 2.00);
export const LLY = stockToken("LLY", 2.00);
export const MU = stockToken("MU", 2.25);
export const TSLA = stockToken("TSLA", 2.50);

export const COLLATERALS: CollateralToken[] = [
  ETH,
  RETH,
  WSTETH,
  AAPL,
  MSFT,
  GOOGL,
  AMZN,
  META,
  NVDA,
  AVGO,
  LLY,
  MU,
  TSLA,
];

export const TOKENS_BY_SYMBOL = {
  AAPL,
  AMZN,
  AVGO,
  BOLD,
  ETH,
  GOOGL,
  LLY,
  LQTY,
  LUSD,
  META,
  MSFT,
  MU,
  NVDA,
  RETH,
  SBOLD,
  TSLA,
  YBOLD,
  WSTETH,
} as const;
