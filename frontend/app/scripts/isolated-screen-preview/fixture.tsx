// Local visual fixture only. Never used by the application or a production build.
import type { Address, Hex } from "viem";
import type { IsolatedMarket } from "../../src/isolated-market-config";
export { ISOLATED_USDG, IsolatedCreditError } from "../../src/isolated-credit";
const addr = (digit: string): Address => `0x${digit.repeat(40)}`;
const hash: Hex = `0x${"ab".repeat(32)}`;
const params = new URLSearchParams(location.search);
export const market: IsolatedMarket = {
  chainId: 4663 as const,
  symbol: "AAPL" as const,
  stock: { executionGate: addr("6"), usdgPrimary: addr("7"), usdgSecondary: addr("8"),
    hashes: { executionGate: hash, usdgPrimary: hash, usdgSecondary: hash } },
  engine: addr("1"),
  pool: addr("2"),
  collateral: "0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9",
  primary: addr("4"),
  secondary: addr("5"),
  hashes: { engine: hash, pool: hash, collateral: hash, primary: hash, secondary: hash, usdg: hash },
  ...(params.has("commissioning") ? { admission: "commissioning" as const } : {}),
};
export const CHAIN_BLOCK_EXPLORER = null;
export const READ_ONLY_DEPLOYMENT = false;
export const getIsolatedMarket = () => market;
export const useAccount = () => ({ address: params.has("disconnected") ? undefined : addr("9"), chainId: params.has("wrongchain") ? 1 : 4663 });
const client = {};
export const usePublicClient = () => client;
export const useBalance = () => ({
  data: params.has("gas-error") ? undefined : { value: params.has("no-gas") ? 0n : 10n ** 16n },
  isError: params.has("gas-error"), isPending: false,
});
export const useWalletClient = () => ({ data: undefined });
export const BorrowerAlerts = () => null;
export const readIsolatedMarket = async () => ({
  blockNumber: 10n,
  cashBalance: (params.has("unfunded") || params.has("disconnected")) ? 0n : params.has("long") ? 123456789012345678901234567890n : 25000000n,
  collateralBalance: (params.has("unfunded") || params.has("disconnected")) ? 0n : params.has("long") ? 1234567890123456789012345678901234567890n : 2n * 10n ** 18n,
  minimumDebt: 1000000n,
  debtLimit: 50000000n,
  maxLtvBps: 5000,
  maxRedeem: 14285714285714n,
  collateral: params.has("disconnected") ? 0n : new URLSearchParams(location.search).has("long") ? 1123456789012345678n : 10n ** 18n,
  debt: params.has("disconnected") || params.has("idle") ? 0n : params.has("urgent") ? 64000000n : 40000000n,
  price: params.has("no-price") ? null : 100n * 10n ** 18n,
  riskPaused: params.has("outage"),
  liquidationLtvBps: 6500,
  aprBps: 1000,
  feeBps: 1000,
  cash: params.has("illiquid") ? 0n : params.has("idle") ? 90000000n : 100000000n,
  principal: params.has("idle") ? 0n : params.has("illiquid") ? 140000000n : 40000000n,
  shares: params.has("disconnected") ? 0n : 100n * 10n ** 12n,
  totalAssets: params.has("idle") ? 90000000n : 140000000n,
  totalShares: 100n * 10n ** 12n,
  maxWithdraw: params.has("illiquid") || params.has("checks") ? 0n : 20000000n,
  maxBorrow: 10000000n,
  maxDeposit: 1000000000n,
  borrowingPrice: params.has("no-price") ? null : 100n * 10n ** 18n,
  lendAllowance: 0n,
  repayAllowance: 0n,
  collateralAllowance: 0n,
});
export const readStockWorkspace = async () => {
  if (params.has("offline")) throw new Error("Simulated read failure");
  const proofUnavailable=new URLSearchParams(location.search).has("outage");
  const state=await readIsolatedMarket();
  return {state:{...state,...(proofUnavailable?{maxBorrow:0n,maxWithdraw:0n}:{})},proofUnavailable};
};
export const stockProofsForAction = async () => undefined;
export const sameReviewedAction = () => true;
export const quoteLenderIntent = async (_c: unknown, _m: unknown, _a: unknown, kind: string, amount: bigint) => ({
  kind,
  amount,
  minShares: amount * 995000n,
  deadline: BigInt(Math.floor(Date.now() / 1000) + 300),
});
export const prepareIsolatedAction = async (_c: unknown, _m: unknown, account: string, intent: unknown) => ({
  kind: "transaction",
  account,
  chainId: 4663,
  to: market.pool,
  data: "0x1234",
  value: 0n,
  gas: 175000n,
  snapshotBlock: 10n,
  validUntil: BigInt(Math.floor(Date.now() / 1000) + 60),
  intent,
});
