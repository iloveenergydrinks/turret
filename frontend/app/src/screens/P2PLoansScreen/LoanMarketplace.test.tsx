// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import {useState} from 'react';
import {cleanup, fireEvent, render, screen, waitFor} from '@testing-library/react';
import {afterEach, beforeEach, expect, test, vi} from 'vitest';
import type {Deployment, Loan} from '../../p2p/client';
import type {BorrowerRequest} from '../../p2p/requests';
const api = vi.hoisted(() => ({load:vi.fn(),sign:vi.fn()}));
vi.mock('../../p2p/requests',async original => ({...await original<typeof import('../../p2p/requests')>(),loadBorrowerRequests:api.load,signRequestAction:api.sign}));
vi.mock('./CollateralMarketPrice',()=>({CollateralMarketPrice:()=>null,hasWeekendPrices:()=>false}));
import {BorrowerRequests} from './BorrowerRequests';
import {LoanMarketplace} from './LoanMarketplace';
const owner='0x1111111111111111111111111111111111111111' as const, lender='0x3333333333333333333333333333333333333333' as const;
const market={address:'0x2222222222222222222222222222222222222222',version:3,chainId:4663,loanDecimals:6,collateralDecimals:18,collateralSymbol:'AAPL',loanSymbol:'USDG',chainName:'Robinhood Chain',rpcUrl:'/api/p2p-rpc',loanToken:lender,collateralToken:owner,runtimeHash:`0x${'a'.repeat(64)}`,startBlock:'1'} as Deployment;
const now=Math.floor(Date.now()/1000);
const request:BorrowerRequest={id:'r1',sequence:1,revision:1,market:market.address,chainId:4663,borrower:owner,createdAt:now,status:'open',acceptedProposalId:null,proposals:[],terms:{principal:'150000000',collateral:'6000000000000000000',interest:'20000000',durationDays:7,expiresAt:now+86400}};
const loan:Loan={id:1n,lender,borrower:'0x0000000000000000000000000000000000000000',isPublic:true,createdAt:now-20,principal:100000000n,collateral:2n*10n**18n,interest:5000000n,durationDays:30,expiresAt:now+86400,dueAt:0,status:'open',fundingAvailable:100000000n};
const callbacks={onRequest:vi.fn(),onFund:vi.fn(),onConnect:vi.fn(),onCreate:vi.fn(),onReview:vi.fn(),onLoadMore:vi.fn()};
function mount(offers:Loan[]=[loan], account:typeof owner|typeof lender|null=null) {
 return render(<BorrowerRequests markets={[market]} account={account} provider={null} intent="lend" {...callbacks} renderBoard={board=><LoanMarketplace board={board} offers={offers.map(loan=>({loan,market}))} markets={[market]} account={account} assetFilter="" onAssetChange={vi.fn()} {...callbacks} loading={false} failed={false} hasMore={false} loadMoreDisabled={false}/>}/>);
}
beforeEach(()=>{vi.clearAllMocks();api.load.mockResolvedValue({requests:[request],nextCursor:null});});
afterEach(cleanup);
test('shows funded offers and public requests together by creation time without connecting',async()=>{
 mount();await screen.findByText('AAPL borrowing request');
 expect(screen.getAllByRole('heading',{level:3})[0]).toHaveAccessibleName('AAPL borrowing request'); expect(screen.getAllByRole('heading',{level:3})[1]).toHaveAccessibleName('AAPL lending offer');
 expect(screen.getByText('Funded · USDG supplied')).toBeVisible();expect(screen.getByText('Unfunded · seeking a lender')).toBeVisible();
 expect(screen.getByText('13.33% for the full term')).toBeVisible();expect(screen.queryByText('No loans ready to borrow')).not.toBeInTheDocument();
 expect(api.load).toHaveBeenCalledWith({market:undefined,account:undefined},expect.any(AbortSignal));expect(api.sign).not.toHaveBeenCalled();
 fireEvent.change(screen.getByLabelText('Funding'),{target:{value:'funded'}});expect(screen.getAllByRole('article')).toHaveLength(1);expect(screen.getByText('AAPL lending offer')).toBeVisible();
 fireEvent.change(screen.getByLabelText('Funding'),{target:{value:'unfunded'}});expect(screen.getAllByRole('article')).toHaveLength(1);expect(screen.getByText('AAPL borrowing request')).toBeVisible();
});
test('requests remain visible when there are no funded offers and use the lender action',async()=>{mount([]);await screen.findByText('AAPL borrowing request');expect(screen.queryByRole('heading',{name:/No .*offer/})).not.toBeInTheDocument();fireEvent.click(screen.getByRole('button',{name:'Connect wallet to offer terms'}));expect(callbacks.onConnect).toHaveBeenCalledOnce();expect(screen.queryByText('0 lender proposals')).not.toBeInTheDocument();});
test('does not describe unknown or insufficient V3 backing as funded',async()=>{mount([{...loan,fundingAvailable:undefined},{...loan,id:2n,fundingAvailable:1n}]);await screen.findByText('AAPL borrowing request');expect(screen.getByText('Funding unverified')).toBeVisible();expect(screen.getByText('Unfunded · funding shortfall')).toBeVisible();fireEvent.change(screen.getByLabelText('Funding'),{target:{value:'funded'}});expect(screen.queryAllByRole('article')).toHaveLength(0);expect(screen.getByRole('heading',{name:'No funded offers yet'})).toBeVisible();});
test('does not publish expired, cancelled, unknown-market or already-funded requests as unfunded',async()=>{api.load.mockResolvedValue({requests:[{...request,id:'expired',terms:{...request.terms,expiresAt:now-1}},{...request,id:'cancelled',status:'cancelled'},{...request,id:'unknown',market:lender},{...request,id:'funded',proposals:[{fundedOffer:{status:'open'}}]},request],nextCursor:null});mount([]);await screen.findByText('AAPL borrowing request');expect(screen.getAllByRole('article')).toHaveLength(1);});
test('shows a request-load error without claiming the marketplace is empty, and allows retry',async()=>{api.load.mockRejectedValueOnce(Error('Offline'));mount([]);await screen.findByRole('button',{name:'Retry requests'});expect(screen.queryByRole('heading',{name:'Be the first to post a loan'})).not.toBeInTheDocument();fireEvent.click(screen.getByRole('button',{name:'Retry requests'}));await screen.findByText('AAPL borrowing request');});
test('own requests cannot receive self-proposals and disconnected visits never sign',async()=>{mount([],owner);await screen.findByText('AAPL borrowing request');expect(screen.getByRole('button',{name:'Cancel request'})).toBeVisible();expect(screen.queryByText('Offer to lend')).not.toBeInTheDocument();expect(api.sign).not.toHaveBeenCalled();});
test('shared search and amount filters include request terms',async()=>{mount();await screen.findByText('AAPL borrowing request');fireEvent.change(screen.getByLabelText('Minimum loan · USDG'),{target:{value:'120'}});expect(screen.getAllByRole('article')).toHaveLength(1);fireEvent.change(screen.getByLabelText('Search loans'),{target:{value:lender}});expect(screen.queryAllByRole('article')).toHaveLength(0);fireEvent.click(screen.getByRole('button',{name:'Clear filters'}));await waitFor(()=>expect(screen.getAllByRole('article')).toHaveLength(2));});

const cashcat: Deployment = {...market, address:'0x36dd2b90e8e8541ccab1258465732c4e961a9657', collateralToken:'0x020bfc650a365f8bb26819deaabf3e21291018b4', collateralSymbol:'CASHCAT',loanToken:'0x5fc5360d0400a0fd4f2af552add042d716f1d168'};
const pons: Deployment = {...cashcat,address:'0x17c1b3cabc49a196ec39b7ba8409226ede756a20',collateralToken:'0x39dbed3a2bd333467115de45665cc57f813c4571',collateralSymbol:'PONS'};
function CategoryMarketplace({initialAsset=""}:{initialAsset?:string}) {
 const [asset,setAsset]=useState(initialAsset);
 const board={listings:[{request:{...request,id:'pons-request'},market:pons,content:<article>PONS borrowing request</article>}],loading:false,failed:false,hasMore:false,controls:null};
 return <LoanMarketplace board={board} markets={[market,cashcat,pons]} offers={[market,cashcat,pons].map(market=>({market,loan}))} account={null} assetFilter={asset} onAssetChange={setAsset} {...callbacks} loading={false} failed={false} hasMore={false} loadMoreDisabled={false}/>;
}
test('memecoins are a subsection of the existing marketplace and include funded offers and requests',()=>{
 render(<CategoryMarketplace/>);
 expect(screen.getByRole('group',{name:'Memecoins'})).toBeInTheDocument();
 expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
 fireEvent.click(screen.getByRole('button',{name:'Browse memecoin loans'}));
 expect(screen.getByRole('heading',{name:'Memecoin loans'})).toBeVisible();
 expect(screen.queryByText('AAPL lending offer')).not.toBeInTheDocument();
 expect(screen.getByText('CASHCAT lending offer')).toBeVisible();
 expect(screen.getByText('PONS lending offer')).toBeVisible();
 expect(screen.getByText('PONS borrowing request')).toBeVisible();
 fireEvent.change(screen.getByLabelText('Funding'),{target:{value:'funded'}});
 expect(screen.queryByText('PONS borrowing request')).not.toBeInTheDocument();
 fireEvent.click(screen.getByRole('button',{name:'Clear filters'}));
 expect(screen.getByText('AAPL lending offer')).toBeVisible();
 expect(screen.getByText('PONS borrowing request')).toBeVisible();
});
test('choosing a specific token leaves the group filter and reviews its exact market',()=>{
 render(<CategoryMarketplace/>);
 fireEvent.click(screen.getByRole('button',{name:'Browse memecoin loans'}));
 fireEvent.change(screen.getByLabelText('Collateral'),{target:{value:'PONS'}});
 expect(screen.queryByText('CASHCAT lending offer')).not.toBeInTheDocument();
 fireEvent.click(screen.getByRole('button',{name:'Review loan'}));
 expect(callbacks.onReview).toHaveBeenCalledWith({market:pons,loan});
 fireEvent.change(screen.getByLabelText('Collateral'),{target:{value:'AAPL'}});
 expect(screen.getByText('AAPL lending offer')).toBeVisible();
 expect(screen.queryByText('PONS lending offer')).not.toBeInTheDocument();
});
test('memecoin category deep links stay inside the P2P marketplace',()=>{
 window.history.replaceState(null,'','/borrow/p2p?category=memecoins');
 try { render(<CategoryMarketplace/>);expect(screen.getByLabelText('Collateral')).toHaveValue('category:memecoins');expect(screen.queryByText('AAPL lending offer')).not.toBeInTheDocument(); }
 finally {window.history.replaceState(null,'','/');}
});
test('an exact market deep link takes priority over a category parameter',()=>{
 window.history.replaceState(null,'',`/borrow/p2p?market=${market.address}&category=memecoins`);
 try {render(<CategoryMarketplace initialAsset="AAPL"/>);expect(screen.getByText('AAPL lending offer')).toBeVisible();expect(screen.getByLabelText('Collateral')).toHaveValue('AAPL');}
 finally {window.history.replaceState(null,'','/');}
});
