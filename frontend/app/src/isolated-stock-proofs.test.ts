import { beforeEach, expect, test, vi } from "vitest";
import { encodeAbiParameters, encodeFunctionData, parseAbiParameters, type Address, type Hex, type PublicClient } from "viem";
import { isolatedPoolAbi, type IsolatedDeployment, type prepareIsolatedAction } from "./isolated-credit";
const mocks=vi.hoisted(()=>({read:vi.fn()}));
vi.mock("./isolated-credit",async original=>({...await original<object>(),readIsolatedMarket:mocks.read}));
import { fetchStockProofs, readStockWorkspace, sameReviewedAction, stockProofsForAction } from "./isolated-stock-proofs";
const addr=(n:string)=>`0x${n.repeat(40)}` as Address;
const hash=`0x${"ab".repeat(32)}` as Hex;
const d:IsolatedDeployment={chainId:4663,engine:addr("1"),pool:addr("2"),collateral:addr("3"),primary:addr("4"),secondary:addr("5"),
  hashes:{engine:hash,pool:hash,collateral:hash,primary:hash,secondary:hash,usdg:hash},
  stock:{executionGate:addr("6"),usdgPrimary:addr("7"),usdgSecondary:addr("8"),riskMonitorUrl:"https://risk.example.test",
    hashes:{executionGate:hash,usdgPrimary:hash,usdgSecondary:hash}}};
const wallet=addr("9"),now=()=>1800000000000,client={} as PublicClient;
function payload(expiry=1800000040n){return {kind:"stock-pool",chainId:4663,engine:d.engine,pool:d.pool,collateral:d.collateral,
  adapter:d.secondary,executionGate:d.stock!.executionGate,usdgPrimary:d.stock!.usdgPrimary,usdgSecondary:d.stock!.usdgSecondary,
  validUntil:Number(expiry),
  health:encodeAbiParameters(parseAbiParameters("(uint80,uint64,uint64,uint64,uint64,bytes32,uint64),bytes,bytes"),
    [[1n,1800000000n,expiry,1799999880n,1800003600n,hash,0n],`0x${"11".repeat(65)}`,`0x${"22".repeat(65)}`]),
  liveness:encodeAbiParameters(parseAbiParameters("(uint64,uint64,uint64,uint64),bytes"),[[1800000000n,1799999880n,expiry,0n],"0x1234"]),
};}
const fetcher=(body:unknown,status=200)=>vi.fn(async()=>new Response(JSON.stringify(body),{status}));
const state={debt:2000000n,principal:2000000n,cash:100000000n,price:100n,borrowingPrice:100n,maxBorrow:1n,maxDeposit:1n,maxWithdraw:1n,maxRedeem:1n};
test("a legacy guard-only health signature is not a stock pool admission proof",async()=>{
  const body=payload();
  body.health=encodeAbiParameters(parseAbiParameters("(uint80,uint64,uint64,uint64,uint64,bytes32,uint64),bytes"),
    [[1n,1800000000n,1800000040n,1799999880n,1800003600n,hash,0n],`0x${"11".repeat(65)}`]);
  await expect(fetchStockProofs(d,fetcher(body),now)).rejects.toThrow(/match/);
});
beforeEach(()=>{vi.resetAllMocks();mocks.read.mockResolvedValue(state);});
test("fetch binds every deployed identity, exact expiry and credential-free HTTPS request",async()=>{
  const body=payload(),f=fetcher(body);
  expect(await fetchStockProofs(d,f,now)).toEqual({health:body.health,liveness:body.liveness});
  expect(f.mock.calls[0]).toEqual([new URL(`https://risk.example.test/stock/approvals/${d.engine}`),
    expect.objectContaining({credentials:"omit",cache:"no-store",redirect:"error",signal:expect.any(AbortSignal)})]);
  for(const key of ["engine","pool","collateral","adapter","executionGate","usdgPrimary","usdgSecondary"]){
    await expect(fetchStockProofs(d,fetcher({...body,[key]:addr("a")}),now)).rejects.toThrow(/match/);
  }
});
test("a supervised market path stays bound to its own proof endpoint",async()=>{
  const supervised={...d,stock:{...d.stock!,riskMonitorUrl:"https://risk.example.test/MSFT"}},f=fetcher(payload());
  await fetchStockProofs(supervised,f,now);
  expect(f).toHaveBeenCalledWith(
    new URL(`https://risk.example.test/MSFT/stock/approvals/${d.engine}`),
    expect.any(Object),
  );
});
test("rejects pilot responses, expired or mismatched lifetimes, malformed and oversized data",async()=>{
  for(const body of [null,{}, {...payload(),kind:"pilot"},{...payload(),chainId:1},payload(1800000009n),payload(1800000046n),
    {...payload(),validUntil:1800000039},{...payload(),health:"0x"},{...payload(),junk:"x".repeat(21000)}]){
    await expect(fetchStockProofs(d,fetcher(body),now)).rejects.toThrow();
  }
  await expect(fetchStockProofs(d,fetcher({},503),now)).rejects.toThrow(/unavailable/);
  await expect(fetchStockProofs(d,vi.fn(async()=>{throw new Error("private server response");}),now)).rejects.toThrow(/unavailable/);
});
test("endpoint cannot carry credentials, insecure remote HTTP, query strings or unexpected paths",async()=>{
  const f=fetcher(payload());
  for(const url of ["http://risk.example.test","https://user:pass@risk.example.test","https://risk.example.test/?key=secret","https://risk.example.test/#x","https://risk.example.test/other","https://risk.example.test/msft"]){
    await expect(fetchStockProofs({...d,stock:{...d.stock!,riskMonitorUrl:url}},f,now)).rejects.toThrow();
  }
  expect(f).not.toHaveBeenCalled();
});
test("proof outage preserves balances and debt but removes permission-dependent limits",async()=>{
  const result=await readStockWorkspace(client,d,wallet,fetcher({},503),now);
  expect(result).toMatchObject({proofUnavailable:true,state:{debt:2000000n,cash:100000000n,borrowingPrice:null,maxBorrow:0n,maxWithdraw:0n,maxRedeem:0n}});
  mocks.read.mockResolvedValue({...state,principal:0n});
  expect((await readStockWorkspace(client,d,wallet,fetcher({},503),now)).state.maxWithdraw).toBe(1n);
  mocks.read.mockRejectedValue(new Error("runtime mismatch"));
  await expect(readStockWorkspace(client,d,wallet,fetcher(payload()),now)).rejects.toThrow(/runtime/);
});
test("market closure preserves a public reason and exact reopening time",async()=>{
  const result=await readStockWorkspace(client,d,wallet,fetcher({
    error:"Borrowing temporarily unavailable",code:"market_closed",reopensAt:1800003600,
  },503),now);
  expect(result).toMatchObject({proofUnavailable:true,proofIssue:{code:"market_closed",reopensAt:1800003600}});
});
test("repayment, top-ups and debt-free exits never depend on HTTP proofs",async()=>{
  const f=fetcher({},503);
  for(const kind of ["repay","close","addCollateral"] as const)expect(await stockProofsForAction(client,d,wallet,kind,f,now)).toBeUndefined();
  mocks.read.mockResolvedValue({...state,debt:0n,principal:0n});
  for(const kind of ["removeCollateral","withdraw","redeem","lend"] as const)expect(await stockProofsForAction(client,d,wallet,kind,f,now)).toBeUndefined();
  expect(f).not.toHaveBeenCalled();
  await expect(stockProofsForAction(client,d,wallet,"borrow",f,now)).rejects.toThrow(/unavailable/);
});
type Step=Awaited<ReturnType<typeof prepareIsolatedAction>>;
const step=(minShares=995000n,health:Hex="0x1234",recipient=wallet):Step=>({kind:"transaction",account:wallet,chainId:4663,to:d.pool,value:0n,gas:200000n,
  snapshotBlock:1n,validUntil:1800000040n,intent:{kind:"lend",amount:1000000n,minShares,deadline:1800000300n},
  data:encodeFunctionData({abi:isolatedPoolAbi,functionName:"depositChecked",args:[1000000n,recipient,minShares,1800000300n,health,"0x5678"]})});
test("proof refresh does not change financial review; recipient, limits and targets do",()=>{
  expect(sameReviewedAction(step(),step(995000n,"0xabcd"))).toBe(true);
  for(const changed of [step(994999n),step(995000n,"0x1234",addr("a")),{...step(),to:d.engine},{...step(),account:addr("a")},
    {...step(),value:1n},{...step(),data:"0x1234" as Hex}])expect(sameReviewedAction(step(),changed)).toBe(false);
});
