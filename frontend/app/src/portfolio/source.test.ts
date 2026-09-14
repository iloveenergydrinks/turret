// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { keccak256, type Address, type PublicClient } from "viem";
import { P2PClient, type Deployment, type Snapshot } from "../p2p/client";
import { P2P_ASSETS, P2P_USDG } from "../p2p/asset-catalog";
import { createPoolSource, createP2PSource, parsePoolRegistry } from "./source";

import { campaigns, TURRET_REWARD_TOKEN } from "../lending/rewards/client";
afterEach(()=>{campaigns.splice(0);});
const account = "0x1111111111111111111111111111111111111111" as Address;
const other = "0x2222222222222222222222222222222222222222" as Address;
const engine = "0x3333333333333333333333333333333333333333" as Address;
const pool = "0x4444444444444444444444444444444444444444" as Address;
const code = "0x60006000";
const hash = keccak256(code);
const collateral = P2P_ASSETS.find(asset => asset.symbol === "SLV")!.address;
const row = {chainId:4663, symbol:"SLV", admission:"active", engine, pool, collateral, hashes:{engine:hash,pool:hash,collateral:hash,usdg:hash}};
const registry = {schemaVersion:1, markets:[row]};
function fixture() {
  const readContract=vi.fn(async ({address,functionName,args}: {address:Address;functionName:string;args?:readonly unknown[]})=>{
    const values:Record<string,unknown>={usdg:P2P_USDG,pool,collateralToken:collateral,asset:P2P_USDG,creditEngine:engine,
      decimals:address===P2P_USDG?6:address===pool?12:18,positions:[2n*10n**18n,0n,0n,0n,0n],positionDebt:25_000_000n,
      balanceOf:args?.[0]===other?0n:30_000_000_000_000n,maxWithdraw:28_000_000n,previewRedeem:31_000_123n};
    if(!(functionName in values))throw new Error("Unnecessary portfolio read: "+functionName);
    return values[functionName];
  });
  const mocks={getChainId:vi.fn(async()=>4663),getBlock:vi.fn(async()=>({number:100n,hash,timestamp:1_800_000_000n})),getCode:vi.fn(async()=>code),readContract};
  return {mocks,client:mocks as unknown as PublicClient};
}
describe("minimal account reads",()=>{
  it("includes staked shares once without inflating immediately withdrawable USDG",async()=>{
    campaigns.push({pool,address:other,administrator:account,runtimeHash:hash,budget:'1000'});
    const {client,mocks}=fixture();const original=mocks.readContract.getMockImplementation()!;
    mocks.readContract.mockImplementation(async request=>{
      if(request.address===other){const values:Record<string,unknown>={stakingToken:pool,rewardToken:TURRET_REWARD_TOKEN,administrator:account,lifetimeBudget:1000n,stakedBalance:10_000_000_000_000n};return values[request.functionName];}
      return original(request);
    });
    const [market]=await createPoolSource({client,load:async()=>registry}).discover();
    await expect(market!.read(account)).resolves.toMatchObject({shares:40_000_000_000_000n,maxWithdraw:28_000_000n});
    expect(mocks.readContract).toHaveBeenCalledWith(expect.objectContaining({functionName:'previewRedeem',args:[40_000_000_000_000n]}));
    mocks.readContract.mockImplementation(async request=>{if(request.address===other)throw Error('Rewards unavailable');return original(request);});
    await expect(market!.read(account)).rejects.toThrow('Rewards unavailable');
  });

  it("shows exact redeemable share value without requesting prices, proofs, allowances, or wallet balances",async()=>{
    const {client,mocks}=fixture();const [market]=await createPoolSource({client,load:async()=>registry}).discover();
    const data=await market!.read(account);
    expect(data).toMatchObject({kind:"pool",account,blockNumber:100n,collateral:2n*10n**18n,debt:25_000_000n,shares:30_000_000_000_000n,lendingAssets:31_000_123n,maxWithdraw:28_000_000n});
    expect(mocks.readContract).toHaveBeenCalledWith(expect.objectContaining({functionName:"previewRedeem",args:[30_000_000_000_000n]}));
    for(const [request] of mocks.readContract.mock.calls)expect(request).toHaveProperty("blockNumber",100n);
    expect(mocks.getCode).toHaveBeenCalledTimes(4);
  });
  it("deduplicates pinned identity reads while keeping account reads separate",async()=>{
    const {client,mocks}=fixture();const [market]=await createPoolSource({client,load:async()=>registry}).discover();
    const [first,second]=await Promise.all([market!.read(account),market!.read(other)]);
    expect(first).toMatchObject({account,shares:30_000_000_000_000n});expect(second).toMatchObject({account:other,shares:0n,lendingAssets:0n});
    expect(mocks.getCode).toHaveBeenCalledTimes(4);
    expect(mocks.readContract.mock.calls.filter(([x])=>x.functionName==="positionDebt")).toHaveLength(2);
  });
  it("authenticates empty markets using engine/pool runtimes and account records without loading unrelated token details",async()=>{
    const {client,mocks}=fixture();
    mocks.readContract.mockImplementation(async({functionName})=>{
      if(functionName==="positions")return [0n,0n,0n,0n,1_800_000_000n];
      if(functionName==="balanceOf")return 0n;
      throw new Error("Empty market fetched unrelated "+functionName);
    });
    const [market]=await createPoolSource({client,load:async()=>registry}).discover();
    await expect(market!.read(account)).resolves.toMatchObject({collateral:0n,debt:0n,shares:0n,lendingAssets:0n,maxWithdraw:0n});
    expect(mocks.getCode).toHaveBeenCalledTimes(2);expect(mocks.readContract).toHaveBeenCalledTimes(2);
  });
  it("does not hide debt when collateral and pool shares are zero",async()=>{
    const {client,mocks}=fixture();const original=mocks.readContract.getMockImplementation()!;
    mocks.readContract.mockImplementation(async request=>request.functionName==="positions"?[0n,0n,1n,0n,0n]:request.functionName==="balanceOf"?0n:original(request));
    const [market]=await createPoolSource({client,load:async()=>registry}).discover();
    await expect(market!.read(account)).resolves.toMatchObject({collateral:0n,debt:25_000_000n,shares:0n});
    expect(mocks.getCode).toHaveBeenCalledTimes(4);
  });
  it("does not wait for another market and retries failed reads without treating failure as zero",async()=>{
    const {client,mocks}=fixture();const second={...row,engine:"0x5555555555555555555555555555555555555555",pool:"0x6666666666666666666666666666666666666666",admission:"legacy"};
    const original=mocks.getCode.getMockImplementation()!;
    mocks.getCode.mockImplementation((...args:unknown[])=>((args[0] as {address:string}).address===second.engine?new Promise(()=>{}):original()) as never);
    const markets=await createPoolSource({client,load:async()=>({...registry,markets:[row,second]})}).discover();
    void markets[1]!.read(account);
    await expect(markets[0]!.read(account)).resolves.toMatchObject({shares:30_000_000_000_000n});
    mocks.readContract.mockRejectedValueOnce(new Error("RPC unavailable"));
    await expect(markets[0]!.read(account)).rejects.toThrow("RPC unavailable");
    await expect(markets[0]!.read(account)).resolves.toMatchObject({shares:30_000_000_000_000n});
  });
  it("rejects wrong chain, changed runtime, wrong bindings, and reorganized snapshot",async()=>{
    for(const defect of ["chain","code","binding","reorg"]){
      const {client,mocks}=fixture();
      if(defect==="chain")mocks.getChainId.mockResolvedValue(1);
      if(defect==="code")mocks.getCode.mockResolvedValue("0x00");
      if(defect==="binding")mocks.readContract.mockResolvedValueOnce(other);
      if(defect==="reorg")mocks.getBlock.mockResolvedValueOnce({number:100n,hash,timestamp:1_800_000_000n}).mockResolvedValue({number:100n,hash:keccak256("0x01"),timestamp:1_800_000_000n});
      const [market]=await createPoolSource({client,load:async()=>registry}).discover();
      await expect(market!.read(account)).rejects.toThrow();
    }
  });
});
describe("discovery and independent P2P accounts",()=>{
  it("includes legacy pools and rejects malformed, duplicate, or unreviewed configuration",()=>{
    const legacy={...row,engine:"0x5555555555555555555555555555555555555555",pool:"0x6666666666666666666666666666666666666666",admission:"legacy"};
    expect(parsePoolRegistry({...registry,markets:[row,legacy]})).toHaveLength(2);
    for(const value of [null,{schemaVersion:1,markets:[row,row]},{...registry,markets:[{...row,collateral:other}]},{...registry,markets:[{...row,hashes:{}}]}])expect(()=>parsePoolRegistry(value)).toThrow();
  });
  it("leaves registry failure rejected and does not convert it into an empty portfolio",async()=>{
    await expect(createPoolSource({load:async()=>{throw new Error("configuration unavailable")}}).discover()).rejects.toThrow("configuration unavailable");
    await expect(createP2PSource(async()=>{throw new Error("P2P unavailable")}).discover()).rejects.toThrow("P2P unavailable");
  });
  it("binds concurrent P2P reads to their own account and forwards the exact pagination cursor",async()=>{
    const deployment={chainId:4663,chainName:"Robinhood Chain",rpcUrl:"/api/rpc",address:engine,loanToken:P2P_USDG,collateralToken:collateral,loanSymbol:"USDG",collateralSymbol:"SLV",loanDecimals:6,collateralDecimals:18,version:2,runtimeHash:hash,startBlock:"1"} satisfies Deployment;
    const pending: (()=>void)[]=[];
    const snapshot=vi.spyOn(P2PClient.prototype,"snapshot").mockImplementation(async function(this:P2PClient,cursor){
      const initial=this.account!;await new Promise<void>(resolve=>pending.push(resolve));
      expect(this.account).toBe(initial);return {account:initial,now:1,blockNumber:1n,offers:[],credits:{USDG:1n,COLLATERAL:2n},nextCursor:cursor??null} as unknown as Snapshot;
    });
    try {
      const [market]=await createP2PSource(async()=>({markets:[deployment],unavailableAssets:[]})).discover();
      const first=market!.read(account,40n);const second=market!.read(other,10n);pending.forEach(done=>done());
      expect(await first).toMatchObject({account,nextCursor:40n,credits:{USDG:1n,COLLATERAL:2n}});expect(await second).toMatchObject({account:other,nextCursor:10n});
    } finally {snapshot.mockRestore();}
  });
});
