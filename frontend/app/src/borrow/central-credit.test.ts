import {expect, test} from 'vitest';
import {centralStatus, type CentralMarket} from './central-credit';

const market: CentralMarket = {id:'AAPL', apiUrl:'https://risk.example/', policyHash:`0x${'1'.repeat(64)}`, weekend:false};
const read = (data: unknown) => centralStatus(market, async () => new Response(JSON.stringify(data)), () => 100_000);
const identity = {market:market.id, policyHash:market.policyHash};

test.each(['MarketClosed', 'RpcUnavailable', 'QuoteStale', 'KeeperUnavailable'])(
  'preserves a fresh %s reason without a price or pool snapshot', async code => {
    const result = await read({...identity, ready:false, code, qualification:{at:99}, prices:null});
    expect(result).toMatchObject({ready:false, code, price:null, checkedAt:99n, validUntil:114n});
  },
);

test('rejects stale or mismatched status evidence', async () => {
  for (const changes of [{qualification:{at:85}}, {qualification:{at:101}}, {market:'MSFT'}, {policyHash:'wrong'}]) {
    await expect(read({...identity, ready:false, code:'MarketClosed', qualification:{at:99}, prices:null, ...changes})).rejects.toThrow();
  }
});

test('a ready claim still requires fresh prices and validated pool availability', async () => {
  await expect(read({...identity, ready:true, code:'healthy', qualification:{at:99}, prices:null})).rejects.toThrow();
});

test('a fresh calendar closure remains readable after the price observation expires',async()=>{
 const result=await read({...identity,ready:false,code:'MarketClosed',qualification:{at:80},
  closedSession:{closed:true,source:'equities-24x5-calendar',checkedAt:99,validUntil:159,reopensAt:200},
  prices:{at:80,closed:true,referenceUpdatedAt:50,liquidationPrice:'1000000000000000000'}});
 expect(result.ready).toBe(false);expect(result.borrowingPrice).toBeNull();expect(result.price).toBeNull();
 expect(result.closedSession?.validUntil).toBe(159n);expect(result.displayReferencePrice).toBe(1000000000000000000n);
});

test('invalid or expired calendar fields never extend stale price evidence',async()=>{
 const closedSession={closed:true,source:'equities-24x5-calendar',checkedAt:99,validUntil:159,reopensAt:200};
 for(const changes of [{validUntil:100},{validUntil:160},{checkedAt:103},{source:'unknown'},{reopensAt:120},{closed:false}]){
  await expect(read({...identity,ready:false,code:'MarketClosed',qualification:{at:80},prices:null,closedSession:{...closedSession,...changes}})).rejects.toThrow();
 }
});
test('a calendar closure can never authorize borrowing',async()=>{
 await expect(read({...identity,ready:true,code:'healthy',qualification:{at:99},closedSession:{closed:true,source:'equities-24x5-calendar',checkedAt:99,validUntil:159,reopensAt:200},
  availability:{paused:false,cash:'20',principal:'0',debtLimit:'100',minimumDebt:'1'},prices:{at:99,borrowPrice:'1',liquidationPrice:'1'}})).rejects.toThrow();
});

test('a small API/browser clock offset cannot discard a valid closed-session confirmation',async()=>{
 const result=await read({...identity,ready:false,code:'CorporateActionChanged',qualification:{at:99},prices:null,
  closedSession:{closed:true,source:'equities-24x5-calendar',checkedAt:101,validUntil:161,reopensAt:200}});
 expect(result.closedSession?.checkedAt).toBe(101n);expect(result.ready).toBe(false);expect(result.price).toBeNull();
});
