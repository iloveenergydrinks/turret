import { decodeFunctionData, encodeAbiParameters, type Address, type PublicClient } from "viem";
import { isolatedEngineAbi, isolatedPoolAbi, IsolatedCreditError, proofExpiry, readIsolatedMarket, requiresStockProofs,
  type IsolatedDeployment, type IsolatedIntent, type StockProofs, type prepareIsolatedAction } from "./isolated-credit";
import { stockProofUrl } from "./stock-proof-url";

export type StockProofIssue = {
  code: "market_closed" | "temporarily_unavailable";
  reopensAt?: number;
};

class StockProofUnavailableError extends IsolatedCreditError {
  constructor(readonly issue: StockProofIssue) {
    super("Stock health checks are unavailable. Retry shortly; repayment and collateral top-ups remain available.");
  }
}

async function boundedJson(response: Response): Promise<unknown> {
  if (!response.body) throw new Error();
  const reader=response.body.getReader();
  const chunks: Uint8Array[]=[];let length=0;
  try { while (true) {
    const part=await reader.read();if(part.done)break;
    length+=part.value.length;
    if(length>20000)throw new Error();chunks.push(part.value);
  }} finally { await reader.cancel().catch(()=>{});reader.releaseLock(); }
  const bytes=new Uint8Array(length);let offset=0;
  for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
  return JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(bytes));
}

export async function fetchStockProofs(d: IsolatedDeployment, fetcher = fetch, now = Date.now): Promise<StockProofs> {
  if (!d.stock?.riskMonitorUrl) throw new IsolatedCreditError("Stock health checks are not configured for this market.");
  const url=stockProofUrl(d.stock.riskMonitorUrl,d.engine);
  let body: unknown;
  try {
    const response=await fetcher(url,{cache:"no-store",redirect:"error",credentials:"omit",signal:AbortSignal.timeout(10000)});
    body=await boundedJson(response);
    if (!response.ok) {
      const reopensAt=(body as {reopensAt?:unknown})?.reopensAt;
      const current=Math.floor(now()/1000);
      const marketClosed=(body as {code?:unknown})?.code==="market_closed"&&Number.isSafeInteger(reopensAt)
        && Number(reopensAt)>current&&Number(reopensAt)<=current+8*86400;
      throw new StockProofUnavailableError(marketClosed
        ? {code:"market_closed",reopensAt:Number(reopensAt)}
        : {code:"temporarily_unavailable"});
    }
  } catch (error) {
    if(error instanceof StockProofUnavailableError)throw error;
    throw new StockProofUnavailableError({code:"temporarily_unavailable"});
  }
  const identities={engine:d.engine,pool:d.pool,collateral:d.collateral,adapter:d.secondary,executionGate:d.stock.executionGate,
    usdgPrimary:d.stock.usdgPrimary,usdgSecondary:d.stock.usdgSecondary};
  try {
    if(!body||typeof body!=="object"||Array.isArray(body))throw new Error();
    const data=body as Record<string,unknown>;
    if(data.kind!=="stock-pool"||data.chainId!==4663||!Object.entries(identities).every(([key,value])=>
      typeof data[key]==="string"&&data[key].toLowerCase()===value.toLowerCase()))throw new Error();
    const proofs={health:data.health,liveness:data.liveness} as StockProofs;
    const expiry=proofExpiry(proofs),seconds=BigInt(Math.floor(now()/1000));
    if(!Number.isSafeInteger(data.validUntil)||BigInt(data.validUntil as number)!==expiry||expiry<seconds+10n||expiry>seconds+45n)throw new Error();
    // The engine simulation still verifies signatures, epochs, round and session.
    return proofs;
  } catch (error) {
    throw new IsolatedCreditError("Stock health checks expired or did not match this market. Refresh and try again.");
  }
}

export async function stockProofsForAction(client: PublicClient, d: IsolatedDeployment, wallet: Address,
  kind: IsolatedIntent["kind"], fetcher = fetch, now = Date.now) {
  if(!d.stock)return undefined;
  const state=await readIsolatedMarket(client,d,wallet,now);
  return requiresStockProofs(d,kind,state)?fetchStockProofs(d,fetcher,now):undefined;
}

export async function readStockWorkspace(client: PublicClient, d: IsolatedDeployment, wallet: Address, fetcher = fetch, now = Date.now) {
  if(!d.stock)return {state:await readIsolatedMarket(client,d,wallet,now),proofUnavailable:false};
  // Fetch proofs first so a healthy refresh reads the market only once. The
  // proof-free snapshot is a recovery path, not a prerequisite for a live quote.
  try {
    const proofs=await fetchStockProofs(d,fetcher,now);
    return {state:await readIsolatedMarket(client,d,wallet,now,proofs),proofUnavailable:false};
  } catch (error) {
    const state=await readIsolatedMarket(client,d,wallet,now);
    // Keep balances, debt and recovery actions visible. Never treat stale cached
    // permission as approval to submit a new risk-increasing action.
    return {state:{...state,borrowingPrice:null,maxBorrow:0n,proofsValidUntil:null,
      ...(state.principal>0n?{maxDeposit:0n,maxWithdraw:0n,maxRedeem:0n}:{})},proofUnavailable:true,
      proofIssue:error instanceof StockProofUnavailableError?error.issue:{code:"temporarily_unavailable" as const}};
  }
}

type Step = Awaited<ReturnType<typeof prepareIsolatedAction>>;
const checkedNames=new Set(["depositAndBorrowChecked","borrowChecked","withdrawCollateralChecked","depositChecked","withdrawChecked","redeemChecked"]);
function financialData(step: Step): string {
  if(step.kind!=="transaction")return step.data;
  try {
    const abi=[...isolatedEngineAbi,...isolatedPoolAbi];
    const decoded=decodeFunctionData({abi,data:step.data});
    if(!checkedNames.has(decoded.functionName))return step.data;
    const fn=abi.find(f=>f.name===decoded.functionName)!;
    return `${decoded.functionName}:${encodeAbiParameters(fn.inputs.slice(0,-2),decoded.args!.slice(0,-2))}`;
  } catch { return step.data; }
}
// Only the two guardian proof fields may refresh without changing the review.
// Recipient, amount, share limits, deadline, selector, target and approval stay exact.
export function sameReviewedAction(previous: Step, fresh: Step): boolean {
  return previous.kind===fresh.kind&&previous.chainId===fresh.chainId&&previous.account.toLowerCase()===fresh.account.toLowerCase()
    &&previous.to.toLowerCase()===fresh.to.toLowerCase()&&previous.value===fresh.value&&financialData(previous)===financialData(fresh);
}
