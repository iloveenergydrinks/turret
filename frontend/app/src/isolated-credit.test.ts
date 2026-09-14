import { expect, test, vi } from "vitest";
import { decodeFunctionData, encodeAbiParameters, erc20Abi, keccak256, type Address, type PublicClient } from "viem";
import { ISOLATED_USDG, MARKET_HEALTH_TYPEHASH, isolatedEngineAbi, isolatedPoolAbi, prepareIsolatedAction, quoteLenderIntent, readIsolatedMarket,
  validateIsolatedDeployment, type IsolatedDeployment } from "./isolated-credit";
const addr = (digit: string) => `0x${digit.repeat(40)}` as Address;
const code = "0x60016000", hash = keccak256(code), blockHash = `0x${"ab".repeat(32)}` as const;
const now = () => 1800000000000;
const wallet=addr("9"),d: IsolatedDeployment = {chainId:4663,engine:addr("1"),pool:addr("2"),collateral:addr("3"),primary:addr("4"),secondary:addr("5"),
  hashes:{engine:hash,pool:hash,collateral:hash,primary:hash,secondary:hash,usdg:hash}};
function fixture(overrides: Record<string,unknown> = {}) {
  const values: Record<string,unknown> = {
    usdg:ISOLATED_USDG,collateralToken:d.collateral,pool:d.pool,primary:d.primary,secondary:d.secondary,MARKET_HEALTH_TYPEHASH,
    stockGuard:d.secondary,executionGate:addr("6"),usdgPrimary:addr("7"),usdgSecondary:addr("8"),
    asset:ISOLATED_USDG,creditEngine:d.engine,riskPaused:false,maxLtvBps:5000,liquidationLtvBps:6500,minimumDebt:1000000n,
    positions:[10n**18n,0n,0n,0n,0n],positionDebt:0n,price:100n*10n**18n,borrowingPrice:100n*10n**18n,availableCash:100000000n,totalAssets:100000000n,
    totalSupply:100n*10n**12n,outstandingPrincipal:0n,debtLimit:1000000000n,borrowAprBps:1000,revenueFeeBps:1000,
    maxDeposit:2n**256n-1n,maxWithdraw:100000000n,maxRedeem:100n*10n**12n,balanceOf:100n*10n**18n,allowance:0n,
    previewDeposit:10n**12n,previewWithdraw:10n**12n,previewRedeem:1000000n,...overrides,
  };
  const mocks = {
    getChainId:vi.fn(async()=>4663),
    getBlock:vi.fn(async()=>({number:10n,hash:blockHash,timestamp:1800000000n})),
    getCode:vi.fn(async()=>code),
    readContract:vi.fn(async({address,functionName}:{address:Address;functionName:string})=>{
      if(functionName==="decimals")return address===ISOLATED_USDG?6:address===d.pool?12:18;
      if(values[functionName] instanceof Error)throw values[functionName];
      return values[functionName];
    }),
    simulateContract:vi.fn(async(_request?: unknown): Promise<{result: unknown}>=>({result:undefined})),estimateGas:vi.fn(async()=>100000n),
  };
  return {client:mocks as unknown as PublicClient,mocks};
}
const stockDeployment: IsolatedDeployment = {...d,stock:{executionGate:addr("6"),usdgPrimary:addr("7"),usdgSecondary:addr("8"),
  hashes:{executionGate:hash,usdgPrimary:hash,usdgSecondary:hash}}};
const stockProofs = (expiry=1800000040n) => ({
  health:encodeAbiParameters([{type:"tuple",components:[{type:"uint80"},{type:"uint64"},{type:"uint64"},
    {type:"uint64"},{type:"uint64"},{type:"bytes32"},{type:"uint64"}]},{type:"bytes"},{type:"bytes"}],
    [[1n,1800000000n,expiry,1799999880n,1800003600n,blockHash,0n],`0x${"11".repeat(65)}`,`0x${"22".repeat(65)}`]),
  liveness:encodeAbiParameters([{type:"tuple",components:[{type:"uint64"},{type:"uint64"},{type:"uint64"},{type:"uint64"}]},{type:"bytes"}],
    [[1800000000n,1799999880n,expiry,0n],"0x1234"]),
});
test("stock workspace loads one market snapshot after fetching proofs",async()=>{
  const {readStockWorkspace}=await import("./isolated-stock-proofs");
  const {client,mocks}=fixture();
  const deployment={...stockDeployment,stock:{...stockDeployment.stock!,riskMonitorUrl:"https://risk.example.test"}};
  const proofs=stockProofs();
  const fetcher=vi.fn(async()=>new Response(JSON.stringify({kind:"stock-pool",chainId:4663,
    engine:d.engine,pool:d.pool,collateral:d.collateral,adapter:d.secondary,...deployment.stock,
    ...proofs,validUntil:1800000040})));
  mocks.simulateContract.mockResolvedValue({result:[100n*10n**18n,100n*10n**18n,100000000n,50000000n,50n*10n**12n]});
  const result=await readStockWorkspace(client,deployment,wallet,fetcher,now);
  expect(result.proofUnavailable).toBe(false);
  expect(result.state.proofsValidUntil).toBe(1800000040n);
  expect(mocks.readContract).toHaveBeenCalledTimes(40);
  expect(mocks.getCode).toHaveBeenCalledTimes(9);
  expect(mocks.getBlock).toHaveBeenCalledTimes(2);
  expect(mocks.simulateContract).toHaveBeenCalledTimes(1);
  // A later refresh, even at the same height, must perform fresh checks.
  await readStockWorkspace(client,deployment,wallet,fetcher,now);
  expect(mocks.readContract).toHaveBeenCalledTimes(80);
  expect(mocks.getCode).toHaveBeenCalledTimes(18);
  expect(mocks.getBlock).toHaveBeenCalledTimes(4);
});
test("stock workspace proof outages read recovery state once and cannot hide a runtime mismatch",async()=>{
  const {readStockWorkspace}=await import("./isolated-stock-proofs");
  const {client,mocks}=fixture({positionDebt:2000000n,outstandingPrincipal:2000000n});
  const deployment={...stockDeployment,stock:{...stockDeployment.stock!,riskMonitorUrl:"https://risk.example.test"}};
  const fetcher=vi.fn(async()=>new Response("{}",{status:503}));
  const result=await readStockWorkspace(client,deployment,wallet,fetcher,now);
  expect(result).toMatchObject({proofUnavailable:true,state:{debt:2000000n,borrowingPrice:null,maxBorrow:0n,maxDeposit:0n,maxWithdraw:0n,maxRedeem:0n}});
  expect(mocks.readContract).toHaveBeenCalledTimes(40);
  expect(mocks.getCode).toHaveBeenCalledTimes(9);
  expect(mocks.getBlock).toHaveBeenCalledTimes(2);
  expect(mocks.simulateContract).not.toHaveBeenCalled();
  mocks.getCode.mockResolvedValue("0x00");
  await expect(readStockWorkspace(client,deployment,wallet,fetcher,now)).rejects.toThrow(/runtime/);
});
test("old stock engine authorization cannot prepare a token approval",async()=>{
  const {client,mocks}=fixture({MARKET_HEALTH_TYPEHASH:blockHash});
  await expect(prepareIsolatedAction(client,stockDeployment,wallet,{kind:"depositBorrow",amount:1000000n,collateralAmount:10n**18n},now,stockProofs()))
    .rejects.toThrow(/Engine-scoped/);
  expect(mocks.simulateContract).not.toHaveBeenCalled();expect(mocks.estimateGas).not.toHaveBeenCalled();
});
test("stock quotes simulate fresh proofs at the pinned block; checked loan carries the same proofs",async()=>{
  const {client,mocks}=fixture({price:new Error("expired"),borrowingPrice:new Error("expired"),allowance:1000000n});
  const proofs=stockProofs();
  mocks.simulateContract.mockResolvedValue({result:[100n*10n**18n,100n*10n**18n,100000000n,50000000n,50n*10n**12n]});
  const step=await prepareIsolatedAction(client,stockDeployment,wallet,{kind:"borrow",amount:1000000n},now,proofs);
  expect(mocks.simulateContract.mock.calls[0]![0]).toMatchObject({functionName:"quoteWithChecks",blockNumber:10n,args:[wallet,proofs.health,proofs.liveness]});
  expect(decodeFunctionData({abi:isolatedEngineAbi,data:step.data})).toMatchObject({functionName:"borrowChecked",args:[1000000n,proofs.health,proofs.liveness]});
  expect(step.validUntil).toBe(1800000040n);
});
test("debt-bearing lender withdrawal refreshes proofs but cannot bypass simulated cash limits",async()=>{
  const {client,mocks}=fixture({outstandingPrincipal:20000000n,maxWithdraw:0n});
  mocks.simulateContract.mockResolvedValue({result:[100n*10n**18n,100n*10n**18n,100000000n,50000000n,50n*10n**12n]});
  const intent={kind:"withdraw" as const,amount:1000000n,maxShares:2n*10n**12n,deadline:1800000300n};
  const step=await prepareIsolatedAction(client,stockDeployment,wallet,intent,now,stockProofs());
  expect(decodeFunctionData({abi:isolatedPoolAbi,data:step.data}).functionName).toBe("withdrawChecked");
  mocks.simulateContract.mockResolvedValue({result:[100n*10n**18n,100n*10n**18n,0n,0n,0n]});
  await expect(prepareIsolatedAction(client,stockDeployment,wallet,intent,now,stockProofs())).rejects.toThrow(/withdrawable/);
});
test("missing, expired, invalid or unbound stock proofs cannot trigger token approvals",async()=>{
  const intent={kind:"depositBorrow" as const,amount:1000000n,collateralAmount:10n**18n};
  const {client,mocks}=fixture();
  await expect(prepareIsolatedAction(client,stockDeployment,wallet,intent,now)).rejects.toThrow(/proofs required/);
  await expect(prepareIsolatedAction(client,stockDeployment,wallet,intent,now,stockProofs(1800000000n))).rejects.toThrow(/expired/);
  await expect(prepareIsolatedAction(client,d,wallet,intent,now,stockProofs())).rejects.toThrow(/reviewed stock/);
  expect(mocks.simulateContract).not.toHaveBeenCalled();
  mocks.simulateContract.mockRejectedValue(new Error("Invalid guardian signature"));
  await expect(prepareIsolatedAction(client,stockDeployment,wallet,intent,now,stockProofs())).rejects.toThrow(/signature/);
  expect(mocks.simulateContract).toHaveBeenCalledTimes(1);
  expect(mocks.estimateGas).not.toHaveBeenCalled();
});
test("stock runtime and engine dependency binding must match before proof simulation",async()=>{
  const badBinding=fixture({usdgPrimary:addr("6")});
  await expect(readIsolatedMarket(badBinding.client,stockDeployment,wallet,now,stockProofs())).rejects.toThrow(/bindings/);
  expect(badBinding.mocks.simulateContract).not.toHaveBeenCalled();
  const badRuntime=fixture();
  badRuntime.mocks.getCode.mockImplementation(async (...args: unknown[])=>{
    const request=args[0] as {address:Address}; return request.address===addr("7")?"0x00":code;
  });
  await expect(readIsolatedMarket(badRuntime.client,stockDeployment,wallet,now)).rejects.toThrow(/runtime/);
});
test("stock repayment and idle lender exits require no proofs during oracle outage",async()=>{
  const {client}=fixture({price:new Error("outage"),borrowingPrice:new Error("outage"),positionDebt:2000000n});
  expect((await prepareIsolatedAction(client,stockDeployment,wallet,{kind:"repay",amount:1000000n},now)).kind).toBe("approval");
  const step=await prepareIsolatedAction(client,stockDeployment,wallet,{kind:"withdraw",amount:1000000n,maxShares:2n*10n**12n,deadline:1800000300n},now);
  expect(decodeFunctionData({abi:isolatedPoolAbi,data:step.data}).functionName).toBe("withdrawWithMaxShares");
});
test("deployment validation rejects missing hashes, overlapping addresses and wrong chain",()=>{
  expect(()=>validateIsolatedDeployment({...d,secondary:d.primary})).toThrow(/Overlapping/);
  expect(()=>validateIsolatedDeployment({...d,chainId:1} as unknown as IsolatedDeployment)).toThrow(/chain/);
  expect(()=>validateIsolatedDeployment({...d,hashes:{...d.hashes,pool:"0x"}})).toThrow(/hash/);
});
test("snapshot includes accrued debt, cash-limited exits and fresh canonical identity",async()=>{
  const {client,mocks}=fixture({positionDebt:40000000n,maxWithdraw:20000000n});
  const s=await readIsolatedMarket(client,d,wallet,now);
  expect(s.debt).toBe(40000000n);expect(s.maxBorrow).toBe(10000000n);expect(s.maxWithdraw).toBe(20000000n);
  for(const [read] of mocks.readContract.mock.calls)expect(read).toHaveProperty("blockNumber",10n);
});
test("unavailable prices preserve debt reads and repayment but block new borrowing",async()=>{
  const {client}=fixture({price:new Error("stale"),positionDebt:2000000n});
  const s=await readIsolatedMarket(client,d,wallet,now);expect(s.price).toBeNull();expect(s.maxBorrow).toBe(0n);
  const repay=await prepareIsolatedAction(client,d,wallet,{kind:"repay",amount:1000000n},now);
  expect(repay.kind).toBe("approval");
  await expect(prepareIsolatedAction(client,d,wallet,{kind:"borrow",amount:1000000n},now)).rejects.toThrow(/unavailable/);
});
test("a liquidation price is not borrowing permission outside a healthy session",async()=>{
  const {client,mocks}=fixture({borrowingPrice:new Error("session closed"),positionDebt:2000000n});
  const s=await readIsolatedMarket(client,d,wallet,now);
  expect(s.price).toBe(100n*10n**18n);expect(s.borrowingPrice).toBeNull();expect(s.maxBorrow).toBe(0n);
  await expect(prepareIsolatedAction(client,d,wallet,{kind:"borrow",amount:1000000n},now)).rejects.toThrow(/unavailable/);
  await expect(prepareIsolatedAction(client,d,wallet,{kind:"removeCollateral",amount:1n},now)).rejects.toThrow(/safe borrowing limit/);
  expect(mocks.simulateContract).not.toHaveBeenCalled();
  expect((await prepareIsolatedAction(client,d,wallet,{kind:"repay",amount:1000000n},now)).kind).toBe("approval");
});
test("runtime and chain mismatches stop all approval preparation",async()=>{
  for(const problem of ["code","chain"]){
    const {client,mocks}=fixture();
    if(problem==="code")mocks.getCode.mockResolvedValue("0x00");else mocks.getChainId.mockResolvedValue(1);
    await expect(prepareIsolatedAction(client,d,wallet,{kind:"addCollateral",amount:1n},now)).rejects.toThrow();
    expect(mocks.simulateContract).not.toHaveBeenCalled();
  }
});
test("changed block hashes and stale clocks cannot produce wallet steps",async()=>{
  const {client,mocks}=fixture();
  mocks.getBlock.mockResolvedValueOnce({number:10n,hash:blockHash,timestamp:1800000000n});
  mocks.getBlock.mockResolvedValue({number:10n,hash:`0x${"cd".repeat(32)}`,timestamp:1800000000n});
  await expect(readIsolatedMarket(client,d,wallet,now)).rejects.toThrow(/changed/);
  await expect(readIsolatedMarket(fixture().client,d,wallet,()=>now()+60000)).rejects.toThrow(/stale/);
});
test("lender quotes round limits conservatively and reject zero-output dust",async()=>{
  const {client}=fixture();
  expect(await quoteLenderIntent(client,d,wallet,"lend",1000000n,50,now)).toEqual({kind:"lend",amount:1000000n,minShares:995000000000n,deadline:1800000300n});
  expect(await quoteLenderIntent(client,d,wallet,"withdraw",1000000n,50,now)).toHaveProperty("maxShares",1005000000000n);
  await expect(quoteLenderIntent(fixture({previewDeposit:1n}).client,d,wallet,"lend",1n,50,now)).rejects.toThrow(/too small/);
});
test("quote deterioration is rejected before even a bounded approval",async()=>{
  const {client,mocks}=fixture({previewDeposit:1n});
  await expect(prepareIsolatedAction(client,d,wallet,{kind:"lend",amount:1000000n,minShares:10n,deadline:1800000300n},now)).rejects.toThrow(/Quote changed/);
  expect(mocks.simulateContract).not.toHaveBeenCalled();
});
test("approval is exact, bound to the pool, and nonzero insufficient allowances reset",async()=>{
  const intent={kind:"lend" as const,amount:1000000n,minShares:1n,deadline:1800000300n};
  for(const allowance of [0n,1n]){
    const step=await prepareIsolatedAction(fixture({allowance}).client,d,wallet,intent,now);
    expect(step.to).toBe(ISOLATED_USDG);expect(step.kind).toBe("approval");
    expect(decodeFunctionData({abi:erc20Abi,data:step.data})).toMatchObject({functionName:"approve",args:[d.pool,allowance?0n:1000000n]});
    expect(step.gas).toBe(175000n);
  }
});
test("sufficient approval produces the reviewed on-chain bounds unchanged",async()=>{
  const intent={kind:"lend" as const,amount:1000000n,minShares:900000000000n,deadline:1800000300n};
  const step=await prepareIsolatedAction(fixture({allowance:1000000n}).client,d,wallet,intent,now);
  expect(step.kind).toBe("transaction");expect(step.to).toBe(d.pool);
  expect(decodeFunctionData({abi:isolatedPoolAbi,data:step.data})).toMatchObject({functionName:"depositWithMinShares",args:[intent.amount,wallet,intent.minShares,intent.deadline]});
});
test("partial repayment cannot leave debt below minimum; close requires sufficient cap",async()=>{
  const {client}=fixture({positionDebt:2000000n});
  for(const intent of [{kind:"repay" as const,amount:1500000n},{kind:"close" as const,amount:1000000n}]){
    await expect(prepareIsolatedAction(client,d,wallet,intent,now)).rejects.toThrow(/Repayment/);
  }
});
test("debt-free collateral exit remains available during pause and oracle outage",async()=>{
  const {client}=fixture({price:new Error("stale"),riskPaused:true});
  expect((await prepareIsolatedAction(client,d,wallet,{kind:"removeCollateral",amount:10n**18n},now)).kind).toBe("transaction");
});
test("expired intents, zero amounts and excessive gas are rejected",async()=>{
  const {client,mocks}=fixture({allowance:1000000n});
  await expect(prepareIsolatedAction(client,d,wallet,{kind:"addCollateral",amount:0n},now)).rejects.toThrow(/amount/);
  await expect(prepareIsolatedAction(client,d,wallet,{kind:"lend",amount:1000000n,minShares:1n,deadline:1799999999n},now)).rejects.toThrow(/expired/);
  mocks.estimateGas.mockResolvedValue(5000000n);
  await expect(prepareIsolatedAction(client,d,wallet,{kind:"addCollateral",amount:1000000n},now)).rejects.toThrow(/Gas estimate/);
});
test("surrendering worthless shares is explicit and cannot substitute for normal redemption",async()=>{
  const intent={kind:"redeemWorthless" as const,amount:10n**12n};
  await expect(prepareIsolatedAction(fixture().client,d,wallet,intent,now)).rejects.toThrow(/zero-value/);
  const step=await prepareIsolatedAction(fixture({totalAssets:0n}).client,d,wallet,intent,now);
  expect(decodeFunctionData({abi:isolatedPoolAbi,data:step.data}).functionName).toBe("redeem");
});
