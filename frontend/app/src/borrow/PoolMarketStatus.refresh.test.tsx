// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import {act,cleanup,fireEvent,render,screen} from '@testing-library/react';
import {afterEach,beforeEach,expect,test,vi} from 'vitest';
const api=vi.hoisted(()=>({read:vi.fn()}));
vi.mock('./central-credit',async importOriginal=>({...await importOriginal<typeof import('./central-credit')>(),centralStatus:api.read,validateCentral:(v:unknown)=>v}));
import {PoolMarketStatus,directoryFacts} from './PoolMarketStatus';
const market={symbol:'AAPL',engine:'0x1',central:{id:'AAPL',apiUrl:'https://example.com/',policyHash:'0x1',weekend:false} as any};
const summary=(changes={})=>({closedSession:null,displayReferencePrice:null,displayReferenceAt:null,validUntil:BigInt(Math.floor(Date.now()/1000)+15),checkedAt:BigInt(Math.floor(Date.now()/1000)),referenceUpdatedAt:80n,marketUpdatedAt:null,marketValidUntil:null,marketSource:'alpaca' as const,ready:true,code:'healthy',marketPrice:null,price:1000000000000000000n,borrowingPrice:900000000000000000n,availability:{paused:false,cash:20000000n,principal:0n,debtLimit:100000000n,minimumDebt:1000000n},...changes});
async function mount(){render(<table><tbody><PoolMarketStatus market={market} name="Apple"/></tbody></table>);await act(async()=>{await Promise.resolve();});}
const advance=async(ms:number)=>act(async()=>{await vi.advanceTimersByTimeAsync(ms);});
beforeEach(()=>{vi.useFakeTimers();vi.setSystemTime(100000);api.read.mockImplementation(async()=>summary());});
afterEach(()=>{cleanup();vi.useRealTimers();vi.resetAllMocks();});
test('healthy refreshes retain Open, price and icon without expiry flicker',async()=>{
 await mount();expect(screen.getByText('Open')).toBeVisible();expect(screen.getByText('1 USDG')).toBeVisible();
 await advance(20000);expect(screen.getByText('Open')).toBeVisible();expect(screen.queryByText(/needs refresh|need refresh|Last known/)).not.toBeInTheDocument();
 expect(document.querySelector('.rusd-market-status-icon svg')).toBeInTheDocument();
 expect(screen.getByRole('link',{name:'View AAPL market'})).toHaveAttribute('href','/borrow?engine=0x1');
});
test('a paused pool explains Closed',async()=>{
 api.read.mockResolvedValue(summary({ready:false,code:'EvidenceExpired',availability:{...summary().availability,paused:true}}));await mount();
 expect(screen.getByText('Closed')).toBeVisible();expect(screen.getByText('Pool paused')).toBeVisible();
});
test('a closed trading market is explained even without a cash snapshot',async()=>{
 api.read.mockResolvedValue(summary({ready:false,code:'MarketClosed',availability:null,price:null}));await mount();
 expect(screen.getByText('Closed')).toBeVisible();expect(screen.getByText('Trading market is closed')).toBeVisible();
});
test('failed polling immediately marks retained values and status; Retry recovers',async()=>{
 await mount();api.read.mockRejectedValue(new Error('secret backend details'));await advance(5000);
 expect(screen.getByText('Last known: Open')).toBeVisible();expect(screen.getByText('1 USDG')).toBeVisible();expect(screen.getByText('Price needs refresh')).toBeVisible();expect(screen.getByText('Refresh failed')).toBeVisible();
 expect(screen.queryByText(/secret backend/)).not.toBeInTheDocument();
 api.read.mockImplementation(async()=>summary());fireEvent.click(screen.getByRole('button',{name:'Retry AAPL status'}));await act(async()=>{await Promise.resolve();});
 expect(screen.getByText('Open')).toBeVisible();expect(screen.queryByText('Refresh failed')).not.toBeInTheDocument();
});
test('initial failure ends Checking and offers Retry',async()=>{
 api.read.mockRejectedValue(new Error('offline'));await mount();expect(screen.getByText('Not confirmed')).toBeVisible();expect(screen.getByText('Refresh failed')).toBeVisible();expect(screen.queryByText('Checking…')).not.toBeInTheDocument();
});
test('fresh rejected responses cannot renew cached price or pool-status timestamps',async()=>{
 await mount();api.read.mockImplementation(async()=>summary({ready:false,code:'QuoteStale',availability:null,price:null}));await advance(5000);
 expect(screen.getByText('Waiting for fresh price checks')).toBeVisible();expect(screen.queryByText('Closed')).not.toBeInTheDocument();
 await advance(10000);expect(screen.getByText('Last known: Open')).toBeVisible();expect(screen.getByText('Pool status needs refresh')).toBeVisible();expect(screen.getByText('Price needs refresh')).toBeVisible();
});
test('a pending refresh cannot keep expired evidence looking fresh',async()=>{
 await mount();api.read.mockReturnValue(new Promise(()=>{}));await advance(15000);
 expect(screen.getByText('Checks need refresh')).toBeVisible();expect(screen.getByText('Last known: Open')).toBeVisible();expect(screen.getByText('Price needs refresh')).toBeVisible();
});
test('unknown rejection is explained without inventing a closure reason',async()=>{
 api.read.mockResolvedValue(summary({ready:false,code:'UnexpectedPrivateError',availability:null,price:null}));await mount();
 expect(screen.getByText('Borrowing checks are unavailable')).toBeVisible();expect(screen.queryByText('Closed')).not.toBeInTheDocument();expect(screen.queryByText('UnexpectedPrivateError')).not.toBeInTheDocument();
});
test('returning to visible tab refreshes immediately',async()=>{
 await mount();const before=api.read.mock.calls.length;
 Object.defineProperty(document,'visibilityState',{configurable:true,value:'visible'});
 fireEvent(document,new Event('visibilitychange'));await act(async()=>{await Promise.resolve();});expect(api.read).toHaveBeenCalledTimes(before+1);
});
test('new status cannot extend an old market quote or change its source time',()=>{
 const first=directoryFacts(undefined,summary({marketPrice:2n,marketUpdatedAt:98n,marketValidUntil:104n}));
 const next=directoryFacts(first,summary({price:null,marketPrice:null,validUntil:120n,checkedAt:105n}));
 expect(next.value).toBe(2n);expect(next.valueUntil).toBe(104n);expect(next.valueAt).toBe(98n);expect(next.statusUntil).toBe(120n);
});
test.each(['CorporateActionChanged','CorporateActionPending'])('fresh %s explains an unavailable loan without claiming a stale pool',async(code)=>{
 api.read.mockResolvedValue(summary({ready:false,code,availability:null,price:null,borrowingPrice:null}));await mount();
 expect(screen.getByText('Unavailable')).toBeVisible();expect(screen.getByText('New AAPL loans are temporarily unavailable.')).toBeVisible();
 expect(screen.queryByText(/Not confirmed|Pool status needs refresh|Last known value|Pool paused/)).not.toBeInTheDocument();
 fireEvent.click(screen.getByText('Why?'));expect(screen.getByText(code==='CorporateActionChanged'?'The token’s conversion rate changed. Updated pricing is being reviewed.':'Waiting for fresh pricing after a token adjustment.')).toBeVisible();
});
test('an expired corporate-action check offers Retry and does not present the old reason as current',async()=>{
 api.read.mockResolvedValueOnce(summary({ready:false,code:'CorporateActionChanged',availability:null,price:null,borrowingPrice:null})).mockReturnValue(new Promise(()=>{}));await mount();await advance(15000);
 expect(screen.queryByText('New AAPL loans are temporarily unavailable.')).not.toBeInTheDocument();expect(screen.getByText('Checks need refresh')).toBeVisible();expect(screen.getByRole('button',{name:'Retry AAPL status'})).toBeVisible();
});

test.each(['EvidenceExpired','RpcUnavailable','QuoteStale','KeeperUnavailable'])('a %s refresh with pool cash cannot reopen a closed trading market',async code=>{
 api.read.mockImplementation(async()=>summary({ready:false,code:'MarketClosed'}));await mount();
 expect(screen.getByText('Closed')).toBeVisible();
 api.read.mockImplementation(async()=>summary({ready:false,code}));await advance(5000);
 expect(screen.queryByText('Open')).not.toBeInTheDocument();
 expect(screen.getByText('Closed')).toBeVisible();
 await advance(10000);
 expect(screen.getByText('Last known: Closed')).toBeVisible();
});
test('an unpaused cash snapshot without trading confirmation cannot establish Open',async()=>{
 api.read.mockImplementation(async()=>summary({ready:false,code:'EvidenceExpired'}));await mount();
 expect(screen.queryByText('Open')).not.toBeInTheDocument();
 expect(screen.getByText('Not confirmed')).toBeVisible();
});

test('a closed market reopens only after a successful ready check',async()=>{
 api.read.mockImplementation(async()=>summary({ready:false,code:'MarketClosed'}));await mount();
 api.read.mockImplementation(async()=>summary());await advance(5000);
 expect(screen.getByText('Open')).toBeVisible();
 expect(screen.queryByText('Trading market is closed')).not.toBeInTheDocument();
});

test('a confirmed calendar closure remains stable across short price and network interruptions',async()=>{
 api.read.mockImplementation(async()=>summary({ready:false,code:'MarketClosed',closedSession:{checkedAt:100n,validUntil:160n,reopensAt:200n}}));
 await mount();api.read.mockRejectedValue(new Error('offline'));await advance(20000);
 expect(screen.getByText('Closed')).toBeVisible();expect(screen.getByText('Trading market is closed')).toBeVisible();
 expect(screen.queryByText(/Refresh failed|Checks need refresh|Price needs refresh|Last known: Closed/)).not.toBeInTheDocument();
 await advance(40000);
 expect(screen.getByText('Last known: Closed')).toBeVisible();expect(screen.getByText('Refresh failed')).toBeVisible();
});

test('a new ready response clears the previous calendar closure immediately',async()=>{
 api.read.mockImplementation(async()=>summary({ready:false,code:'MarketClosed',closedSession:{checkedAt:100n,validUntil:160n,reopensAt:200n}}));await mount();
 api.read.mockImplementation(async()=>summary());await advance(5000);
 expect(screen.getByText('Open')).toBeVisible();expect(screen.queryByText('Trading market is closed')).not.toBeInTheDocument();
});
