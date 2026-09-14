import { describe, expect, test, vi } from "vitest";
import registry from "../../public/p2p-markets.json";
import type { Deployment, Loan, OfferPage } from "../p2p/client";
import { exactOffers, memecoinMarkets, offerAvailability, readOfferPages } from "./memecoin-offers";

export const market = registry.markets.find(m=>m.collateralSymbol==="CASHCAT"&&m.version===3) as Deployment;
const now=1_800_000_000_000;
export const offer:Loan={id:1n,isPublic:true,status:"open",createdAt:now/1000-60,expiresAt:now/1000+600,dueAt:0,
  durationDays:7,principal:100_000000n,interest:5_000000n,collateral:1000n*10n**18n,fundingAvailable:100_000000n,
  lender:"0x1111111111111111111111111111111111111111",borrower:"0x0000000000000000000000000000000000000000"};
export const page:OfferPage={offers:[offer],now:now/1000,blockNumber:100n,paused:false,nextCursor:null,
  health:{status:"ok",reasons:[],blockNumber:"100",blockHash:`0x${"a".repeat(64)}`,checkedAt:now}};
const read=(p:Partial<OfferPage>={})=>({market,page:{...page,...p},checkedAt:now,error:false});

describe("funded memecoin discovery",()=>{
  test("admits eight reviewed deployments, not symbol spoofs or legacy contracts",()=>{
    const pons=registry.markets.find(m=>m.collateralSymbol==="PONS"&&m.version===3) as Deployment;
    expect(memecoinMarkets(registry.markets as Deployment[]).map(m=>m.collateralSymbol).sort()).toEqual(["CASHCAT","PONS","PIPEDOG","TENDIES","HMM","IF","JUGGERNAUT","YOLO"].sort());
    expect(memecoinMarkets([{...market,address:offer.lender},{...market,collateralToken:offer.lender},{...market,legacy:true},{...market,version:2}])).toEqual([]);
    expect(memecoinMarkets([{...pons,address:market.address},{...pons,collateralToken:market.collateralToken},
      {...pons,chainId:1},{...pons,loanToken:offer.lender},{...pons,legacy:true},{...pons,version:2}])).toEqual([]);
  });
  test("counts backed, open, public offers once and excludes the connected lender's own offers",()=>{
    expect(offerAvailability(read({offers:[offer,offer,{...offer,id:2n,isPublic:false},{...offer,id:3n,status:"active"}]}),now)).toMatchObject({state:"available",capacity:100_000000n,offers:[offer]});
    expect(offerAvailability(read(),now,offer.lender)).toMatchObject({state:"empty",capacity:0n});
  });
  test("expiry is exclusive and stale or future observations cannot advertise funding",()=>{
    expect(offerAvailability(read({offers:[{...offer,expiresAt:now/1000}]}),now).state).toBe("empty");
    expect(offerAvailability(read(),now+30_000).state).toBe("unavailable");
    expect(offerAvailability(read(),now-1).state).toBe("unavailable");
    expect(offerAvailability(read({now:now/1000-60}),now).state).toBe("unavailable");
  });
  test("missing backing and incomplete history differ from a confirmed empty market",()=>{
    expect(offerAvailability(read({offers:[{...offer,fundingAvailable:undefined}]}),now)).toMatchObject({state:"unavailable",unverified:1});
    expect(offerAvailability(read({offers:[],nextCursor:40n}),now)).toMatchObject({state:"unavailable",incomplete:true});
    expect(offerAvailability(read({offers:[{...offer,fundingAvailable:1n}]}),now).state).toBe("empty");
    expect(offerAvailability(read({offers:[]}),now)).toMatchObject({state:"empty",incomplete:false});
  });
  test("pause and failed health prevent new loan availability",()=>{
    expect(offerAvailability(read({paused:true}),now).state).toBe("paused");
    expect(offerAvailability(read({health:{...page.health!,status:"blocked"}}),now).state).toBe("unavailable");
    expect(offerAvailability({...read(),error:true},now).offers).toEqual([]);
  });
  test("an exact amount cannot silently become a partial or larger loan",()=>{
    expect(exactOffers([offer],75_000000n,7)).toEqual([]);
    expect(exactOffers([offer],100_000000n,14)).toEqual([]);
    expect(exactOffers([offer],100_000000n,7)).toEqual([offer]);
  });
  test("loads historical offers at one block and preserves an incomplete cursor",async()=>{
    const browse=vi.fn().mockResolvedValueOnce({...page,offers:[],nextCursor:80n})
      .mockResolvedValueOnce({...page,nextCursor:40n});
    const result=await readOfferPages({browse},2);
    expect(browse).toHaveBeenLastCalledWith(80n,100n);
    expect(result).toMatchObject({offers:[offer],nextCursor:40n});
  });
  test("does not combine page observations across a reorg or nondecreasing cursor",async()=>{
    for(const second of [{...page,blockNumber:101n},{...page,health:{...page.health!,blockHash:`0x${"b".repeat(64)}`}},{...page,nextCursor:80n}]) {
      const browse=vi.fn().mockResolvedValueOnce({...page,nextCursor:80n}).mockResolvedValueOnce(second);
      await expect(readOfferPages({browse})).rejects.toThrow();
    }
  });
});
