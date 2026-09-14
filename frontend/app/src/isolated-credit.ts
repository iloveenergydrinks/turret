import { decodeAbiParameters, encodeFunctionData, erc20Abi, getAddress, isAddress, keccak256, parseAbi, stringToHex, type Abi, type Address, type Hex, type PublicClient } from "viem";

export const ISOLATED_USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168" as const;
export const MARKET_HEALTH_TYPEHASH = keccak256(stringToHex("MarketHealth(uint80 roundId,uint64 observedAt,uint64 validUntil,uint64 sessionOpen,uint64 sessionClose,bytes32 roundHash,uint64 epoch)"));
export const isolatedEngineAbi = parseAbi([
  "function usdg() view returns(address)", "function collateralToken() view returns(address)",
  "function MARKET_HEALTH_TYPEHASH() view returns(bytes32)",
  "function pool() view returns(address)", "function primary() view returns(address)", "function secondary() view returns(address)",
  "function riskPaused() view returns(bool)", "function maxLtvBps() view returns(uint16)",
  "function liquidationLtvBps() view returns(uint16)", "function minimumDebt() view returns(uint256)",
  "function positions(address) view returns(uint256,uint256,uint256,uint256,uint256)",
  "function positionDebt(address) view returns(uint256)", "function price() view returns(uint256)",
  "function borrowingPrice() view returns(uint256)",
  "function stockGuard() view returns(address)", "function executionGate() view returns(address)",
  "function usdgPrimary() view returns(address)", "function usdgSecondary() view returns(address)",
  "function quoteWithChecks(address,bytes,bytes) returns(uint256,uint256,uint256,uint256,uint256)",
  "function depositAndBorrowChecked(uint256,uint256,bytes,bytes)", "function borrowChecked(uint256,bytes,bytes)",
  "function withdrawCollateralChecked(uint256,address,bytes,bytes)",
  "function depositCollateral(address,uint256)", "function depositAndBorrow(uint256,uint256)",
  "function borrow(uint256)", "function withdrawCollateral(uint256,address)",
  "function repay(address,uint256) returns(uint256)", "function close(uint256,address) returns(uint256)",
]);
export const isolatedPoolAbi = parseAbi([
  "function asset() view returns(address)", "function collateralToken() view returns(address)",
  "function creditEngine() view returns(address)", "function availableCash() view returns(uint256)",
  "function totalAssets() view returns(uint256)", "function totalSupply() view returns(uint256)",
  "function outstandingPrincipal() view returns(uint256)", "function debtLimit() view returns(uint256)",
  "function borrowAprBps() view returns(uint16)", "function revenueFeeBps() view returns(uint16)",
  "function maxDeposit(address) view returns(uint256)", "function maxWithdraw(address) view returns(uint256)",
  "function maxRedeem(address) view returns(uint256)", "function balanceOf(address) view returns(uint256)",
  "function previewDeposit(uint256) view returns(uint256)", "function previewWithdraw(uint256) view returns(uint256)",
  "function previewRedeem(uint256) view returns(uint256)",
  "function depositWithMinShares(uint256,address,uint256,uint256) returns(uint256)",
  "function withdrawWithMaxShares(uint256,address,address,uint256,uint256) returns(uint256)",
  "function redeemWithMinAssets(uint256,address,address,uint256,uint256) returns(uint256)",
  "function redeem(uint256,address,address) returns(uint256)",
  "function depositChecked(uint256,address,uint256,uint256,bytes,bytes) returns(uint256)",
  "function withdrawChecked(uint256,address,address,uint256,uint256,bytes,bytes) returns(uint256)",
  "function redeemChecked(uint256,address,address,uint256,uint256,bytes,bytes) returns(uint256)",
]);
export type StockProofs = { health: Hex; liveness: Hex };
export type StockDependencies = {
  executionGate: Address; usdgPrimary: Address; usdgSecondary: Address;
  riskMonitorUrl?: string;
  hashes: Record<"executionGate" | "usdgPrimary" | "usdgSecondary", Hex>;
};
export type IsolatedDeployment = {
  chainId: 4663;
  engine: Address; pool: Address; collateral: Address; primary: Address; secondary: Address;
  hashes: Record<"engine" | "pool" | "collateral" | "primary" | "secondary" | "usdg", Hex>;
  stock?: StockDependencies;
};
export type IsolatedIntent =
  | { kind: "lend"; amount: bigint; minShares: bigint; deadline: bigint }
  | { kind: "withdraw"; amount: bigint; maxShares: bigint; deadline: bigint }
  | { kind: "redeem"; amount: bigint; minAssets: bigint; deadline: bigint }
  | { kind: "depositBorrow"; amount: bigint; collateralAmount: bigint }
  | { kind: "addCollateral" | "removeCollateral" | "borrow" | "repay" | "close" | "redeemWorthless"; amount: bigint };
const uintMax = 2n ** 256n - 1n;
const same = (a: unknown, b: Address) => typeof a === "string" && a.toLowerCase() === b.toLowerCase();
export class IsolatedCreditError extends Error {}
function demand(ok: unknown, message: string): asserts ok { if (!ok) throw new IsolatedCreditError(message); }
const amount = (value: bigint) => demand(typeof value === "bigint" && value > 0n && value < uintMax, "Enter a positive, bounded amount.");
const minimum = (...values: bigint[]) => values.reduce((a,b) => a < b ? a : b);
const positive = (value: bigint) => value > 0n ? value : 0n;
const stockKeys = ["executionGate", "usdgPrimary", "usdgSecondary"] as const;

// Signatures and session/epoch/round bindings are validated by the contracts in
// eth_call. Decode expiries here only to bound the resulting wallet request.
export function proofExpiry(proofs: StockProofs): bigint {
  demand([proofs.health, proofs.liveness].every(p => /^0x(?:[\da-f]{2})+$/i.test(p) && p.length <= 8194), "Invalid stock proofs.");
  const [health,priceSignature,marketSignature] = decodeAbiParameters([{type:"tuple",components:[{type:"uint80"},{type:"uint64"},{type:"uint64"},
    {type:"uint64"},{type:"uint64"},{type:"bytes32"},{type:"uint64"}]},{type:"bytes"},{type:"bytes"}],proofs.health);
  demand([priceSignature,marketSignature].every(s=>s.length===132), "Engine-scoped stock approval required.");
  const [liveness] = decodeAbiParameters([{type:"tuple",components:[{type:"uint64"},{type:"uint64"},
    {type:"uint64"},{type:"uint64"}]},{type:"bytes"}],proofs.liveness);
  return minimum(health[2],liveness[2]);
}
export function requiresStockProofs(d: IsolatedDeployment, kind: IsolatedIntent["kind"], state: {debt:bigint;principal:bigint}) {
  return Boolean(d.stock) && (kind === "borrow" || kind === "depositBorrow"
    || kind === "removeCollateral" && state.debt > 0n
    || ["lend","withdraw","redeem"].includes(kind) && state.principal > 0n);
}

export function validateIsolatedDeployment(d: IsolatedDeployment) {
  demand(d.chainId === 4663, "Wrong deployment chain.");
  const addresses = [d.engine,d.pool,d.collateral,d.primary,d.secondary,ISOLATED_USDG];
  if (d.stock) addresses.push(...stockKeys.map(key => d.stock![key]));
  demand(addresses.every(a => isAddress(a) && !/^0x0{40}$/i.test(a)), "Invalid deployment address.");
  demand(new Set(addresses.map(a => a.toLowerCase())).size === addresses.length, "Overlapping deployment addresses.");
  for (const key of ["engine","pool","collateral","primary","secondary","usdg"] as const) {
    demand(/^0x[\da-f]{64}$/i.test(d.hashes[key]), "Missing reviewed runtime hash.");
  }
  if (d.stock) for (const key of stockKeys) {
    demand(/^0x[\da-f]{64}$/i.test(d.stock.hashes?.[key] ?? "") && !/^0x0{64}$/i.test(d.stock.hashes[key]), "Missing reviewed stock runtime hash.");
  }
}
async function canonical(client: PublicClient, blockNumber: bigint, hash: Hex, timestamp: bigint, now: () => number) {
  const ms = now();
  demand(Number.isSafeInteger(ms) && ms > 0 && timestamp * 1000n <= BigInt(ms)
    && BigInt(ms) - timestamp * 1000n < 60000n, "Market snapshot is stale. Refresh before signing.");
  demand((await client.getBlock({ blockNumber })).hash === hash, "Market snapshot changed. Refresh before signing.");
}

export async function readIsolatedMarket(client: PublicClient, d: IsolatedDeployment, wallet: Address, now = Date.now, proofs?: StockProofs) {
  validateIsolatedDeployment(d);
  demand(isAddress(wallet) && !/^0x0{40}$/i.test(wallet), "Connect a valid wallet.");
  demand(await client.getChainId() === 4663, "Switch to Robinhood Chain.");
  const block = await client.getBlock();
  demand(block.number !== null && block.hash !== null, "Mined block unavailable.");
  const blockNumber = block.number;
  const read = (address: Address, abi: Abi, functionName: string, args: readonly unknown[] = []) =>
    client.readContract({ address, abi, functionName, args, blockNumber });
  await Promise.all((["engine","pool","collateral","primary","secondary","usdg"] as const).map(async key => {
    const code = await client.getCode({ address: key === "usdg" ? ISOLATED_USDG : d[key], blockNumber });
    demand(code && code !== "0x" && keccak256(code).toLowerCase() === d.hashes[key].toLowerCase(), "Deployment runtime does not match. Do not approve funds.");
  }));
  if (d.stock) {
    demand(await read(d.engine,isolatedEngineAbi,"MARKET_HEALTH_TYPEHASH") === MARKET_HEALTH_TYPEHASH,
      "Engine-scoped stock authorization is unavailable. Do not approve funds.");
    await Promise.all(stockKeys.map(async key => {
      const code = await client.getCode({address:d.stock![key],blockNumber});
      demand(code && code !== "0x" && keccak256(code).toLowerCase() === d.stock!.hashes[key].toLowerCase(), "Stock dependency runtime does not match. Do not approve funds.");
    }));
    const bindings = await Promise.all([read(d.engine,isolatedEngineAbi,"stockGuard"),
      ...stockKeys.map(key => read(d.engine,isolatedEngineAbi,key))]);
    demand([d.secondary,...stockKeys.map(key => d.stock![key])].every((v,i) => same(bindings[i],v)), "Stock dependency bindings do not match. Do not approve funds.");
  }
  const bindings = await Promise.all([
    read(d.engine,isolatedEngineAbi,"usdg"),read(d.engine,isolatedEngineAbi,"pool"),
    read(d.engine,isolatedEngineAbi,"collateralToken"),read(d.engine,isolatedEngineAbi,"primary"),read(d.engine,isolatedEngineAbi,"secondary"),
    read(d.pool,isolatedPoolAbi,"asset"),read(d.pool,isolatedPoolAbi,"creditEngine"),read(d.pool,isolatedPoolAbi,"collateralToken"),
    read(ISOLATED_USDG,erc20Abi,"decimals"),read(d.collateral,erc20Abi,"decimals"),read(d.pool,erc20Abi,"decimals"),
  ]);
  demand([ISOLATED_USDG,d.pool,d.collateral,d.primary,d.secondary,ISOLATED_USDG,d.engine,d.collateral]
    .every((value,i) => same(bindings[i],value)) && bindings[8] === 6 && bindings[9] === 18 && bindings[10] === 12,
  "Deployment bindings do not match. Do not approve funds.");
  const e = <T>(name: string, args: readonly unknown[] = []) => read(d.engine,isolatedEngineAbi,name,args) as Promise<T>;
  const p = <T>(name: string, args: readonly unknown[] = []) => read(d.pool,isolatedPoolAbi,name,args) as Promise<T>;
  const t = (token: Address, name: string, args: readonly unknown[]) => read(token,erc20Abi,name,args) as Promise<bigint>;
  const [position,debt,storedPrice,storedBorrowingPrice,riskPaused,maxLtvBps,liquidationLtvBps,minimumDebt,cash,totalAssets,totalShares,
    principal,debtLimit,aprBps,feeBps,storedMaxDeposit,storedMaxWithdraw,storedMaxRedeem,shares,cashBalance,collateralBalance,
    lendAllowance,repayAllowance,collateralAllowance] = await Promise.all([
    e<readonly bigint[]>("positions",[wallet]),e<bigint>("positionDebt",[wallet]),e<bigint>("price").catch(() => null),
    e<bigint>("borrowingPrice").catch(() => null),
    e<boolean>("riskPaused"),e<number>("maxLtvBps"),e<number>("liquidationLtvBps"),e<bigint>("minimumDebt"),
    p<bigint>("availableCash"),p<bigint>("totalAssets"),p<bigint>("totalSupply"),p<bigint>("outstandingPrincipal"),p<bigint>("debtLimit"),
    p<number>("borrowAprBps"),p<number>("revenueFeeBps"),p<bigint>("maxDeposit",[wallet]),p<bigint>("maxWithdraw",[wallet]),
    p<bigint>("maxRedeem",[wallet]),p<bigint>("balanceOf",[wallet]),t(ISOLATED_USDG,"balanceOf",[wallet]),
    t(d.collateral,"balanceOf",[wallet]),t(ISOLATED_USDG,"allowance",[wallet,d.pool]),
    t(ISOLATED_USDG,"allowance",[wallet,d.engine]),t(d.collateral,"allowance",[wallet,d.engine]),
  ]);
  let price = storedPrice, borrowingPrice = storedBorrowingPrice;
  let maxDeposit = storedMaxDeposit, maxWithdraw = storedMaxWithdraw, maxRedeem = storedMaxRedeem;
  let proofsValidUntil: bigint | null = null;
  if (proofs) {
    demand(d.stock, "Stock proofs require a reviewed stock deployment.");
    proofsValidUntil = proofExpiry(proofs);
    demand(proofsValidUntil > block.timestamp && proofsValidUntil * 1000n > BigInt(now()), "Stock proofs expired. Refresh before signing.");
    const {result} = await client.simulateContract({address:d.engine,abi:isolatedEngineAbi,functionName:"quoteWithChecks",
      args:[wallet,proofs.health,proofs.liveness],account:wallet,blockNumber});
    [price,borrowingPrice,maxDeposit,maxWithdraw,maxRedeem] = result;
  }
  demand(position.length === 5, "Position data unavailable.");
  const collateral = position[0]!;
  const debtAt = (collateralAmount: bigint) => borrowingPrice === null ? 0n : collateralAmount * borrowingPrice / 10n**18n * BigInt(maxLtvBps) / 10000n / 10n**12n;
  const maxBorrow = riskPaused || price === null || borrowingPrice === null || maxDeposit === 0n ? 0n
    : minimum(positive(debtAt(collateral)-debt),cash,positive(debtLimit-principal));
  await canonical(client,blockNumber,block.hash,block.timestamp,now);
  return { deployment:d,wallet:getAddress(wallet),blockNumber,blockHash:block.hash,timestamp:block.timestamp,
    collateral,debt,price,borrowingPrice,riskPaused,maxLtvBps,liquidationLtvBps,minimumDebt,cash,totalAssets,totalShares,
    principal,debtLimit,aprBps,feeBps,maxDeposit,maxWithdraw,maxRedeem,shares,cashBalance,collateralBalance,
    lendAllowance,repayAllowance,collateralAllowance,maxBorrow,proofsValidUntil };
}
export type IsolatedMarketState = Awaited<ReturnType<typeof readIsolatedMarket>>;

export async function quoteLenderIntent(client: PublicClient, d: IsolatedDeployment, wallet: Address,
  kind: "lend" | "withdraw" | "redeem", value: bigint, slippageBps = 50, now = Date.now, proofs?: StockProofs): Promise<IsolatedIntent> {
  amount(value);
  demand(Number.isInteger(slippageBps) && slippageBps >= 0 && slippageBps <= 100, "Slippage must be between 0 and 1%.");
  const state = await readIsolatedMarket(client,d,wallet,now,proofs);
  const fn = kind === "lend" ? "previewDeposit" : kind === "withdraw" ? "previewWithdraw" : "previewRedeem";
  const quote = await client.readContract({ address:d.pool,abi:isolatedPoolAbi,functionName:fn,args:[value],blockNumber:state.blockNumber });
  amount(quote);
  const deadline = state.timestamp+300n;
  const lower = quote*BigInt(10000-slippageBps)/10000n;
  const upper = (quote*BigInt(10000+slippageBps)+9999n)/10000n;
  await canonical(client,state.blockNumber,state.blockHash,state.timestamp,now);
  if (kind === "withdraw") return { kind,amount:value,maxShares:upper,deadline };
  demand(lower > 0n, "Amount too small for a protected quote.");
  return kind === "lend" ? { kind,amount:value,minShares:lower,deadline } : { kind,amount:value,minAssets:lower,deadline };
}

// Returns one simulated wallet step, never broadcasts. After each approval receipt,
// call again with the SAME user-reviewed intent; changed quotes require new consent.
export async function prepareIsolatedAction(client: PublicClient, d: IsolatedDeployment, wallet: Address,
  intent: IsolatedIntent, now = Date.now, proofs?: StockProofs) {
  amount(intent.amount);
  const s = await readIsolatedMarket(client,d,wallet,now,proofs);
  const needsProofs = requiresStockProofs(d,intent.kind,s);
  demand(!needsProofs || proofs, "Fresh stock proofs required. Refresh before signing.");
  let target = d.engine, abi: Abi = isolatedEngineAbi, functionName: string, args: readonly unknown[];
  let approval: { token: Address; spender: Address; required: bigint; allowance: bigint } | undefined;
  if ("deadline" in intent) demand(intent.deadline >= s.timestamp && intent.deadline <= s.timestamp+300n, "Quote expired. Review a new quote.");
  const newDebt = s.debt+intent.amount;
  const borrowLimit = (coll: bigint) => s.borrowingPrice === null ? 0n : coll*s.borrowingPrice/10n**18n*BigInt(s.maxLtvBps)/10000n/10n**12n;
  switch (intent.kind) {
    case "lend":
      amount(intent.minShares);
      demand(intent.amount <= s.maxDeposit && intent.amount <= s.cashBalance, "Deposit exceeds your USDG balance or market limit.");
      target=d.pool;abi=isolatedPoolAbi;functionName="depositWithMinShares";args=[intent.amount,wallet,intent.minShares,intent.deadline];
      approval={token:ISOLATED_USDG,spender:d.pool,required:intent.amount,allowance:s.lendAllowance};break;
    case "withdraw":
      amount(intent.maxShares);
      demand(intent.amount <= s.maxWithdraw, "Requested USDG is not currently withdrawable.");
      target=d.pool;abi=isolatedPoolAbi;functionName="withdrawWithMaxShares";args=[intent.amount,wallet,wallet,intent.maxShares,intent.deadline];break;
    case "redeem":
      amount(intent.minAssets);
      demand(intent.amount <= s.maxRedeem, "Requested shares are not currently redeemable.");
      target=d.pool;abi=isolatedPoolAbi;functionName="redeemWithMinAssets";args=[intent.amount,wallet,wallet,intent.minAssets,intent.deadline];break;
    case "redeemWorthless":
      // A separate, explicit intent: surrender zero-value shares after a complete
      // recognized loss. Ordinary redemptions must retain a positive minimum.
      demand(s.totalAssets === 0n && intent.amount <= s.maxRedeem, "Only zero-value shares can use this action.");
      target=d.pool;abi=isolatedPoolAbi;functionName="redeem";args=[intent.amount,wallet,wallet];break;
    case "depositBorrow":
    case "borrow": {
      const extra = intent.kind === "depositBorrow" ? intent.collateralAmount : 0n;
      if (intent.kind === "depositBorrow") amount(extra);
      demand(!s.riskPaused && s.price !== null && s.borrowingPrice !== null && s.maxDeposit > 0n, "New borrowing is unavailable.");
      demand(extra <= s.collateralBalance && newDebt >= s.minimumDebt && newDebt <= borrowLimit(s.collateral+extra)
        && intent.amount <= s.cash && intent.amount <= positive(s.debtLimit-s.principal), "Borrow exceeds collateral, liquidity or debt limits.");
      functionName=intent.kind === "borrow" ? "borrow" : "depositAndBorrow";
      args=intent.kind === "borrow" ? [intent.amount] : [extra,intent.amount];
      if (extra) approval={token:d.collateral,spender:d.engine,required:extra,allowance:s.collateralAllowance};break;
    }
    case "addCollateral":
      demand(intent.amount <= s.collateralBalance, "Insufficient collateral balance.");
      functionName="depositCollateral";args=[wallet,intent.amount];
      approval={token:d.collateral,spender:d.engine,required:intent.amount,allowance:s.collateralAllowance};break;
    case "removeCollateral":
      demand(intent.amount <= s.collateral && (s.debt === 0n || !s.riskPaused && s.borrowingPrice !== null
        && s.debt <= borrowLimit(s.collateral-intent.amount)), "Collateral withdrawal would exceed your safe borrowing limit.");
      functionName="withdrawCollateral";args=[intent.amount,wallet];break;
    case "repay":
    case "close": {
      const paid = minimum(s.debt,intent.amount), remaining = s.debt-paid;
      demand(paid > 0n && paid <= s.cashBalance && (remaining === 0n || remaining >= s.minimumDebt)
        && (intent.kind !== "close" || remaining === 0n), "Repayment is insufficient, exceeds your balance or leaves debt below the minimum.");
      functionName=intent.kind;args=intent.kind === "close" ? [intent.amount,wallet] : [wallet,intent.amount];
      approval={token:ISOLATED_USDG,spender:d.engine,required:intent.amount,allowance:s.repayAllowance};break;
    }
    default: throw new IsolatedCreditError("Unsupported market action.");
  }
  if (needsProofs && proofs) {
    const checked: Record<string,string> = {depositWithMinShares:"depositChecked",withdrawWithMaxShares:"withdrawChecked",
      redeemWithMinAssets:"redeemChecked",depositAndBorrow:"depositAndBorrowChecked",borrow:"borrowChecked",withdrawCollateral:"withdrawCollateralChecked"};
    demand(checked[functionName], "Unsupported checked stock action.");
    functionName=checked[functionName]!;args=[...args,proofs.health,proofs.liveness];
  }
  if (intent.kind === "lend" || intent.kind === "withdraw" || intent.kind === "redeem") {
    const fn = intent.kind === "lend" ? "previewDeposit" : intent.kind === "withdraw" ? "previewWithdraw" : "previewRedeem";
    const current = await client.readContract({address:d.pool,abi:isolatedPoolAbi,functionName:fn,args:[intent.amount],blockNumber:s.blockNumber});
    demand(intent.kind === "withdraw" ? current <= intent.maxShares
      : current >= (intent.kind === "lend" ? intent.minShares : intent.minAssets), "Quote changed beyond your limit. Review a new quote.");
  }
  let kind: "approval" | "transaction" = "transaction";
  if (approval && approval.allowance < approval.required) {
    kind="approval";target=approval.token;abi=erc20Abi;functionName="approve";
    // Reset a nonzero allowance first; never request an unlimited approval.
    args=[approval.spender,approval.allowance > 0n ? 0n : approval.required];
  }
  await client.simulateContract({address:target,abi,functionName,args,account:wallet,blockNumber:s.blockNumber});
  const data = encodeFunctionData({abi,functionName,args});
  const estimate = await client.estimateGas({account:wallet,to:target,data,value:0n,blockNumber:s.blockNumber});
  // A later block can checkpoint interest into previously empty storage slots.
  // Include headroom, but reject unexpectedly expensive calls for manual review.
  const gas = (estimate*125n+99n)/100n+50000n;
  demand(estimate > 0n && gas <= 5000000n, "Gas estimate exceeds the transaction limit. Do not sign; refresh or contact support.");
  await canonical(client,s.blockNumber,s.blockHash,s.timestamp,now);
  const validUntil = needsProofs && s.proofsValidUntil !== null ? minimum(s.timestamp+60n,s.proofsValidUntil) : s.timestamp+60n;
  demand(validUntil*1000n > BigInt(now()), "Stock proofs expired. Refresh before signing.");
  return { kind,account:s.wallet,chainId:4663 as const,to:target,value:0n,
    data,gas,snapshotBlock:s.blockNumber,validUntil,intent };
}
