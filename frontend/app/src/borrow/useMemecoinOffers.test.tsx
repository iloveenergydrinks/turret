// @vitest-environment jsdom
import {cleanup,renderHook,waitFor} from "@testing-library/react";
import {afterEach,beforeEach,expect,test,vi} from "vitest";
import registry from "../../public/p2p-markets.json";
const mocks=vi.hoisted(()=>({wallet:{address:"0x1111111111111111111111111111111111111111" as `0x${string}`|undefined,chainId:4663},browse:vi.fn(),balance:vi.fn()}));
vi.mock("wagmi",()=>({useAccount:()=>mocks.wallet}));
vi.mock("../p2p/client",()=>({loadP2PRegistry:async()=>registry,P2PClient:class {
  publicClient={readContract:mocks.balance};
  constructor(private market:{collateralSymbol:string}){}
  browse=()=>mocks.browse(this.market.collateralSymbol);
}}));
import {useMemecoinOffers} from "./useMemecoinOffers";
const cashcat=registry.markets.find(m=>m.version===3&&m.collateralSymbol==="CASHCAT")!;
const pons=registry.markets.find(m=>m.version===3&&m.collateralSymbol==="PONS")!;
const now=1_800_000_000_000;
const page={offers:[],blockNumber:1n,now:now/1000,nextCursor:null,paused:false,health:{status:"ok"}};
beforeEach(()=>{
  vi.useFakeTimers({toFake:["Date"]});vi.setSystemTime(now);
  mocks.wallet={address:"0x1111111111111111111111111111111111111111",chainId:4663};
  mocks.browse.mockReset().mockResolvedValue(page);mocks.balance.mockReset().mockResolvedValue(10n);
});
afterEach(()=>{cleanup();vi.useRealTimers();});
test("a failed market does not hide fresh holdings from another market",async()=>{
  mocks.browse.mockImplementation(async(symbol:string)=>{if(symbol==="PONS")throw Error("unavailable");return page;});
  const {result}=renderHook(()=>useMemecoinOffers());await waitFor(()=>expect(result.current.loading).toBe(false));
  expect(result.current.balances[cashcat.address]).toBe(10n);
  expect(result.current.balances[pons.address]).toBeUndefined();
  expect(result.current.reads.find(r=>r.market.address===pons.address)?.error).toBe(true);
});
test("stale market observations expire only that market's holdings",async()=>{
  mocks.browse.mockImplementation(async(symbol:string)=>({...page,now:page.now-(symbol==="PONS"?60:0)}));
  const {result}=renderHook(()=>useMemecoinOffers());await waitFor(()=>expect(result.current.loading).toBe(false));
  expect(result.current.balances[cashcat.address]).toBe(10n);
  expect(result.current.balances[pons.address]).toBeUndefined();
});
test("disconnecting clears balances without treating an absent wallet as a match",async()=>{
  const {result,rerender}=renderHook(()=>useMemecoinOffers());await waitFor(()=>expect(result.current.loading).toBe(false));
  expect(result.current.balances[pons.address]).toBe(10n);
  mocks.wallet={address:undefined,chainId:4663};rerender();
  expect(result.current.balances).toEqual({});
  await waitFor(()=>expect(result.current.loading).toBe(false));
  expect(result.current.balances).toEqual({});
});
