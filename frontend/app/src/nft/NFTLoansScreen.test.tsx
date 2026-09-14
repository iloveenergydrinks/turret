// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { DraftForm, NFTLoansScreen, NFTRequestCard } from './NFTLoansScreen';
const mock = vi.hoisted(() => ({ verify: vi.fn(), list: vi.fn(), submit: vi.fn(), approve: vi.fn(), fund: vi.fn(), balance: vi.fn(), send: vi.fn(), approveNFT: vi.fn(), offer: vi.fn(), last: vi.fn(), account: '0x1111111111111111111111111111111111111111' }));
vi.mock('../comps/AppLayout/AccountButton', () => ({ AccountButton: () => null }));
vi.mock('./NFTAlerts', () => ({ NFTAlerts: () => null }));
vi.mock('../borrow/BorrowPageHeader', () => ({ BorrowPageHeader: () => null }));
vi.mock('../p2p/P2PAppLayout', () => ({ P2PAppLayout: ({children}: any) => children }));
vi.mock('../wallet/useWalletSession', () => ({ WalletSessionProvider: ({children}: any) => children, useWalletSession: () => ({ account: mock.account, chainId:4663, provider:{request:vi.fn()} }) }));
vi.mock('./requests', async original => ({ ...await original<any>(), listNFTRequests:mock.list, submitNFTRequest:mock.submit }));
vi.mock('./client', async original => ({ ...await original<any>(), validateNFTConfig:(c:any)=>c, NFTClient:class {
  constructor(public config:any) {} verify=mock.verify;
  latestOffers=async()=>({offers:[],more:false}); pending=()=>null; approveUSDG=mock.approve; requireUSDGBalance=mock.balance; send=mock.send; approveNFT=mock.approveNFT; fundOffer=mock.fund; offer=mock.offer; lastFunding=mock.last; accountOffers=async()=>({offers:[],more:false});
} }));
const borrower='0x1111111111111111111111111111111111111111', lender='0x2222222222222222222222222222222222222222';
const terms={collection:lender as `0x${string}`,tokenId:'1056',principal:'10000000',interest:'10000000',durationDays:30,expiresAt:2000000000};
const open={id:'request',revision:1,borrower,terms,status:'open',proposals:[{id:'proposal',lender,terms,cancelled:false,fundedOffer:null}],acceptedProposalId:null};
const agreed={...open,revision:2,status:'agreed',acceptedProposalId:'proposal'};
beforeEach(()=>{Element.prototype.scrollIntoView=vi.fn();mock.verify.mockReset().mockImplementation(async()=>({timestamp:BigInt(Math.floor(Date.now()/1000))}));mock.account=borrower;mock.list.mockReset().mockResolvedValue({requests:[],nextCursor:null});mock.submit.mockReset();mock.approve.mockReset();mock.fund.mockReset();mock.balance.mockReset();mock.send.mockReset();mock.approveNFT.mockReset();mock.offer.mockReset();mock.last.mockReset().mockReturnValue(null);vi.stubGlobal('fetch',vi.fn(async()=>({ok:true,json:async()=>({address:lender,chainId:4663,collections:[]})})));});
afterEach(()=>{cleanup();window.history.replaceState({}, "", "/");vi.unstubAllGlobals();});
async function requests(){render(<NFTLoansScreen embedded/>);await screen.findByText(/Earlier terms from/); expect(screen.getByText(/Earlier terms from/)).toBeVisible();}
test('earlier agreement is informational and never asks the borrower to sign again',async()=>{
 mock.list.mockResolvedValue({requests:[agreed],nextCursor:null});await requests();
 expect(screen.queryByRole('button',{name:'Agree to terms'})).not.toBeInTheDocument();
 expect(screen.getByText(/These earlier terms moved no money/)).toBeVisible();
 expect(mock.submit).not.toHaveBeenCalled();
});
test('lender goes directly from a borrower listing to a deposit review',async()=>{
 mock.account=lender;mock.list.mockResolvedValue({requests:[agreed],nextCursor:null});await requests();
 fireEvent.click(screen.getByRole('button',{name:'Offer to lend'}));
 expect(screen.getByText(/Next: review and deposit your USDG/)).toBeVisible();
 expect(screen.queryByText('Sign and send lending terms')).not.toBeInTheDocument();
 expect(mock.submit).not.toHaveBeenCalled();
});
test('cancelled on-chain offers are never described as ready to accept',async()=>{
 mock.list.mockResolvedValue({requests:[{...agreed,proposals:[{...agreed.proposals[0],fundedOffer:{id:'1',status:'cancelled',checkedAt:1}}]}],nextCursor:null});await requests();
 expect(screen.getByText(/On-chain offer #1: cancelled/)).toBeVisible();
 expect(screen.queryByText(/USDG deposited. The NFT owner can review and accept/)).not.toBeInTheDocument();
});

test('lender sees who receives the money and exact repayment, including live edits',()=>{
 render(<DraftForm draft={{kind:'offer',asset:{collection:lender,collectionName:'Cash Cats',tokenId:'1056',name:'Cash Cats #1056',image:''},terms}} busy={false} onCancel={()=>{}} onReview={()=>{}}/>);
 expect(screen.getByRole('heading',{name:'Lend USDG to this NFT’s owner'})).toBeVisible();
 expect(screen.getByText('You lend: 10 USDG.')).toBeVisible();
 expect(screen.getByText('Borrower repays: 20 USDG within 30 days.')).toBeVisible();
 expect(screen.getByText(/The NFT owner receives the money/)).toHaveTextContent('The contract holds Cash Cats #1056, not your wallet.');
 fireEvent.change(screen.getByLabelText('USDG you will lend'),{target:{value:'20.000001'}});
 fireEvent.change(screen.getByLabelText('Total interest · USDG'),{target:{value:'10'}});
 expect(screen.getByText('Borrower repays: 30.000001 USDG within 30 days.')).toBeVisible();
});
test('borrower sees repayment and loss of their own NFT',()=>{
 render(<DraftForm draft={{kind:'request',asset:{collection:lender,collectionName:'Cash Cats',tokenId:'1056',name:'Cash Cats #1056',image:''},terms}} busy={false} onCancel={()=>{}} onReview={()=>{}}/>);
 expect(screen.getByText('You receive: 10 USDG.')).toBeVisible();
 expect(screen.getByText('You repay: 20 USDG within 30 days.')).toBeVisible();
 expect(screen.getByText(/the lender can claim your entire NFT/)).toBeVisible();
 expect(screen.getByRole('button',{name:'Review what you will repay'})).toBeVisible();
});

test('wallet errors keep their explanation and remove the obsolete confirmation prompt',async()=>{
 mock.account=lender;
 const currentTerms={...terms,expiresAt:Math.floor(Date.now()/1000)+86400};
 mock.list.mockResolvedValue({requests:[{...agreed,terms:currentTerms,proposals:[{...agreed.proposals[0],terms:currentTerms}]}],nextCursor:null});
 vi.stubGlobal('fetch',vi.fn(async()=>({ok:true,json:async()=>({address:lender,chainId:4663,collections:[{address:lender,enabled:true,name:'Cash Cats'}]})})));
 mock.fund.mockImplementation(async(_p,_a,_amount,status)=>{status('Confirm the reviewed transaction in your wallet.');throw {code:-32002,message:'Request already pending'};});
 await requests();fireEvent.click(screen.getByRole('button',{name:'Review and deposit USDG'}));
 const redundantForm=screen.queryByRole('button',{name:'Review what you will lend'});if(redundantForm)fireEvent.click(redundantForm);
 fireEvent.click(screen.getByRole('checkbox'));fireEvent.click(screen.getByRole('button',{name:'Approve and deposit 10 USDG'}));
 expect(await screen.findByText('A request is already open in your wallet. Open the wallet and complete or dismiss it before trying again.')).toBeVisible();
 expect(screen.queryByText('Confirm the reviewed transaction in your wallet.')).not.toBeInTheDocument();
});
test('depositing a saved proposal goes straight to confirmation without another terms form',async()=>{
 mock.account=lender;mock.list.mockResolvedValue({requests:[agreed],nextCursor:null});await requests();
 fireEvent.click(screen.getByRole('button',{name:'Review and deposit USDG'}));
 expect(screen.getByRole('region',{name:'Review NFT loan terms'})).toBeVisible();
 expect(screen.queryByRole('region',{name:'NFT loan terms'})).not.toBeInTheDocument();
});

test('confirmed deposit closes the form even when the follow-up offer read fails',async()=>{
 mock.account=lender;
 const currentTerms={...terms,expiresAt:Math.floor(Date.now()/1000)+86400};
 mock.list.mockResolvedValue({requests:[{...agreed,terms:currentTerms,proposals:[{...agreed.proposals[0],terms:currentTerms}]}],nextCursor:null});
 vi.stubGlobal('fetch',vi.fn(async()=>({ok:true,json:async()=>({address:lender,chainId:4663,collections:[{address:lender,enabled:true,name:'Cash Cats'}]})})));
 mock.fund.mockResolvedValue({id:7n,existing:false});mock.last.mockReturnValue({id:'7',hash:'0x'+'a'.repeat(64)});mock.offer.mockRejectedValue(Error('RPC interrupted'));
 await requests();fireEvent.click(screen.getByRole('button',{name:'Review and deposit USDG'}));fireEvent.click(screen.getByRole('checkbox'));fireEvent.click(screen.getByRole('button',{name:'Approve and deposit 10 USDG'}));
 await waitFor(()=>expect(screen.queryByRole('button',{name:'Approve and deposit 10 USDG'})).not.toBeInTheDocument());
 expect(await screen.findByRole('button',{name:'Open offer #7'})).toBeVisible();
 expect(mock.fund).toHaveBeenCalledTimes(1);expect(mock.submit).not.toHaveBeenCalled();
});

test.each(['offer','request'] as const)('NFT %s percentage converts to exact terms on review',kind=>{
 const onReview=vi.fn();render(<DraftForm draft={{kind,asset:{collection:lender,collectionName:'Cash Cats',tokenId:'1056',name:'Cash Cats #1056',image:''},terms}} busy={false} onCancel={()=>{}} onReview={onReview}/>);
 fireEvent.click(screen.getByRole('button',{name:'%'}));fireEvent.change(screen.getByLabelText('Total interest · %'),{target:{value:'5'}});
 fireEvent.change(screen.getByLabelText(kind==='request'?'USDG you want to borrow':'USDG you will lend'),{target:{value:'100'}});
 fireEvent.click(screen.getByRole('button',{name:kind==='request'?'Review what you will repay':'Review what you will lend'}));
 expect(onReview).toHaveBeenCalledWith(expect.objectContaining({principal:'100000000',interest:'5000000'}));
});

function collectionDirectoryFixture(){
 const collections=[{address:lender,name:'Cash Cats',slug:'cash-cats',image:'',enabled:true},{address:borrower,name:'PYO',slug:'pyo',image:'',enabled:false}];
 mock.list.mockResolvedValue({requests:[],nextCursor:null});
 vi.stubGlobal('fetch',vi.fn(async(url)=>({ok:true,json:async()=>String(url).includes('/assets?')?{items:[{collection:lender,collectionName:'Cash Cats',tokenId:'1',name:'Cash Cat #1',image:''}],nextPage:null}:{address:lender,chainId:4663,collections}})));
}
test('loan requests are the default market and owners can list an NFT',async()=>{
 collectionDirectoryFixture();render(<NFTLoansScreen embedded/>);
 await waitFor(()=>expect(mock.list).toHaveBeenCalled());
 expect(screen.getByRole('button',{name:'Loan requests',exact:true})).toHaveAttribute('aria-current','page');
 expect(screen.getByRole('button',{name:'List my NFT',exact:true})).toBeEnabled();
});
test('Collections lists supported collections once without browsing unsolicited NFT offers',async()=>{
 collectionDirectoryFixture();render(<NFTLoansScreen embedded/>);await waitFor(()=>expect(screen.getByRole('button',{name:'Collections'})).toBeEnabled());
 fireEvent.click(screen.getByRole('button',{name:'Collections',exact:true}));
 expect(await screen.findByRole('heading',{name:'Cash Cats',exact:true})).toBeVisible();
 expect(screen.queryByText('PYO')).not.toBeInTheDocument();
 expect(screen.queryByRole('button',{name:'Make a loan offer'})).not.toBeInTheDocument();
 expect(screen.queryByRole('combobox',{name:'Collection',exact:true})).not.toBeInTheDocument();
 expect(vi.mocked(fetch).mock.calls.some(([url])=>String(url).includes('/assets?'))).toBe(false);
 fireEvent.click(screen.getByRole('button',{name:'View loan requests'}));
 expect(screen.getByRole('combobox',{name:'Collection',exact:true})).toHaveValue(lender);
 expect(screen.getAllByRole('option',{name:'Cash Cats',exact:true})).toHaveLength(1);
});

async function depositReview(){
 mock.account=lender;
 const currentTerms={...terms,expiresAt:Math.floor(Date.now()/1000)+86400};
 mock.list.mockResolvedValue({requests:[{...agreed,terms:currentTerms,proposals:[{...agreed.proposals[0],terms:currentTerms}]}],nextCursor:null});
 vi.stubGlobal('fetch',vi.fn(async()=>({ok:true,json:async()=>({address:lender,chainId:4663,collections:[{address:lender,enabled:true,name:'Cash Cats'}]})})));
 await requests();fireEvent.click(screen.getByRole('button',{name:'Review and deposit USDG'}));fireEvent.click(screen.getByRole('checkbox'));
 return screen.getByRole('region',{name:'Review NFT loan terms'});
}
test('deposit click acknowledges preflight inside the review before the wallet is reached',async()=>{
 const review=await depositReview();mock.verify.mockImplementationOnce(()=>new Promise(()=>{}));
 fireEvent.click(within(review).getByRole('button',{name:'Approve and deposit 10 USDG'}));
 expect(within(review).getByRole('status')).toHaveTextContent(/Checking/);
 expect(within(review).getByRole('button',{name:/Checking/})).toBeDisabled();
 expect(mock.fund).not.toHaveBeenCalled();
});
test('failed deposit explains the failure beside the clicked button and permits retry',async()=>{
 const review=await depositReview();mock.fund.mockRejectedValueOnce({code:-32002,message:'Request already pending'});
 fireEvent.click(within(review).getByRole('button',{name:'Approve and deposit 10 USDG'}));
 expect(await within(review).findByRole('alert')).toHaveTextContent('A request is already open in your wallet');
 expect(within(review).getByRole('button',{name:'Approve and deposit 10 USDG'})).toBeEnabled();
});

const zero='0x0000000000000000000000000000000000000000';
async function selectedLoan(status:number, wallet=borrower, withdrawal=false){
 mock.account=wallet;
 const now=BigInt(Math.floor(Date.now()/1000));
 mock.offer.mockResolvedValue({id:7n,status,lender,terms:{collection:lender,tokenId:1056n,principal:10000000n,interest:10000000n,duration:86400n,expiresAt:now+86400n,borrower},dueAt:status===2&&wallet===lender?now-90000n:now+86400n,nftBeneficiary:withdrawal&&wallet===borrower?borrower:zero,usdgCredit:withdrawal&&wallet===lender?10000000n:0n});
 window.history.replaceState({},'', '/?offer=7');render(<NFTLoansScreen embedded/>);
 const details=await screen.findByRole('region',{name:'NFT loan details'});
 await waitFor(()=>expect(within(details).queryByText(/Checking the latest loan status/)).not.toBeInTheDocument());
 const consent=within(details).queryByRole('checkbox');if(consent)fireEvent.click(consent);
 return details;
}
test('repayment checks principal plus interest before requesting a token approval',async()=>{
 const details=await selectedLoan(2);
 mock.balance.mockRejectedValueOnce(Error('You need 20 USDG to repay this loan. This wallet has 10 USDG on Robinhood Chain.'));
 fireEvent.click(within(details).getByRole('button',{name:'Repay 20 USDG'}));
 expect(await within(details).findByRole('alert')).toHaveTextContent('You need 20 USDG to repay this loan');
 expect(mock.balance).toHaveBeenCalledWith(borrower,20000000n,'repay this loan');
 expect(mock.approve).not.toHaveBeenCalled();expect(mock.send).not.toHaveBeenCalled();
 expect(within(details).getByRole('alert')).toHaveFocus();
});
test.each([
 ['accept',1,borrower,false,/Approve NFT and borrow/],
 ['cancel',1,lender,false,/Cancel offer/],
 ['repay',2,borrower,false,/Repay 20/],
 ['default',2,lender,false,/Settle default/],
 ['withdraw NFT',3,borrower,true,/Withdraw NFT/],
 ['withdraw USDG',5,lender,true,/Withdraw 10 USDG/],
] as const)('%s reports pending checks and wallet failure beside its action',async(_name,status,wallet,withdrawal,label)=>{
 const details=await selectedLoan(status,wallet,withdrawal);
 let fail!:(e:unknown)=>void;
 mock.send.mockImplementationOnce(()=>new Promise((_resolve,reject)=>{fail=reject;}));
 fireEvent.click(within(details).getByRole('button',{name:label}));
 expect(within(details).getByRole('status')).toHaveTextContent(/Checking/);
 await waitFor(()=>expect(fail).toBeTypeOf('function'));
 fail({code:-32002,message:'Request already pending'});
 expect(await within(details).findByRole('alert')).toHaveTextContent('A request is already open in your wallet');
 expect(within(details).getByRole('button',{name:label})).toBeEnabled();
 expect(within(details).getByRole('alert')).toHaveFocus();
});


function requestCard(status = "open", expiresAt = 2000000000) {
 const onOpen = vi.fn(), onLend = vi.fn(), onResume = vi.fn();
 const row = {...open,liveOffers:[{id:"7",lender,status,checkedAt:1,terms:{...terms,durationDays:5,expiresAt}}]};
 render(<NFTRequestCard row={row as any} asset={{collection:lender,collectionName:"Cash Cats",tokenId:"1056",name:"Cash Cats #1056",image:""}} account={borrower} now={1900000000} busy={false} onLend={onLend} onRemove={()=>{}} onOpen={onOpen} onResume={onResume}/>);
 return {onOpen,onLend,onResume};
}
test("current and earlier NFT proposals keep their terms and actions visible", () => {
 const {onOpen}=requestCard();
 const live=screen.getByRole("region",{name:"Offer #7"});
 expect(within(live).getByText("5 days")).toBeVisible();
 expect(screen.getAllByText("30 days").some(el => !el.closest("details"))).toBe(true);
 expect(screen.getByText(/Earlier terms from/)).toBeVisible();
 expect(screen.getByRole("heading", {name:/Earlier proposals and offers/}).closest("details")).toBeNull();
 fireEvent.click(within(live).getByRole("button",{name:"Review counteroffer #7"}));expect(onOpen).toHaveBeenCalledWith("7");
 expect(screen.getByText(/Earlier terms from/)).toBeVisible();
});
test.each(["cancelled","expired","repaid","defaulted"])("%s NFT offers are retained in history and cannot appear ready to accept", status=>{
 const {onOpen}=requestCard(status);
 expect(screen.queryByRole("button",{name:"Review counteroffer #7"})).not.toBeInTheDocument();
 expect(screen.getByRole("heading", {name:/Earlier proposals and offers/}).closest("details")).toBeNull();
 
 const row=screen.getByRole("region",{name:"Offer #7"});
 expect(within(row).getByText(/Acceptance is closed/)).toBeVisible();
 fireEvent.click(within(row).getByRole("button"));expect(onOpen).toHaveBeenCalledWith("7");
});
test("an open NFT offer past its acceptance deadline appears in history as expired",()=>{
 requestCard("open",1800000000);expect(screen.queryByRole("button",{name:"Review counteroffer #7"})).not.toBeInTheDocument();
 expect(screen.getByRole("heading",{name:"Offer #7 · expired"})).toBeVisible();
});


test("a counteroffer explains that the loan has not started and marks the changed repayment period", () => {
 requestCard();
 const offer=screen.getByRole("region",{name:"Offer #7"});
 expect(within(offer).getByRole("heading",{name:"Lender’s counteroffer #7"})).toBeVisible();
 expect(within(offer).getByText("Requested: 30 days")).toBeVisible();
 expect(within(offer).getByText("Loan not started.")).toBeVisible();
 expect(within(offer).getByText(/Waiting for you to accept/)).toBeVisible();
 expect(within(offer).getByText(/10 USDG is held in the contract/)).toBeVisible();
 expect(within(offer).getByText("Interest for the full term")).toBeVisible();
});
test.each([null,lender] as const)("matching offers do not imply changed terms or tell non-owners to accept (%s)",account=>{
 const row={...open,proposals:[],liveOffers:[{id:"8",lender,status:"open",checkedAt:1,terms:{...terms,principal:'010000000'}}]};
 render(<NFTRequestCard row={row as any} asset={{collection:lender,collectionName:"Cash Cats",tokenId:"1056",name:"Cash Cats #1056",image:""}} account={account} now={1900000000} busy={false} onLend={()=>{}} onRemove={()=>{}} onOpen={()=>{}} onResume={()=>{}}/>);
 expect(screen.getByRole("heading",{name:"Lender’s offer #8"})).toBeVisible();
 expect(screen.queryByText(/Requested:/)).not.toBeInTheDocument();
 expect(screen.getByText(/Waiting for the NFT owner to accept/)).toBeVisible();
 expect(screen.getByRole("button",{name:"View offer #8"})).toBeVisible();
});
test("changed amounts are compared with the request, including the resulting repayment",()=>{
 const row={...open,proposals:[],liveOffers:[{id:"8",lender,status:"open",checkedAt:1,terms:{...terms,principal:'15000000',interest:'2000000'}}]};
 render(<NFTRequestCard row={row as any} asset={{collection:lender,collectionName:"Cash Cats",tokenId:"1056",name:"Cash Cats #1056",image:""}} account={borrower} now={1900000000} busy={false} onLend={()=>{}} onRemove={()=>{}} onOpen={()=>{}} onResume={()=>{}}/>);
 const offer=screen.getByRole("region",{name:"Offer #8"});
 expect(within(offer).getAllByText("Requested: 10 USDG")).toHaveLength(2);
 expect(within(offer).getByText("Requested: 20 USDG")).toBeVisible();
 expect(within(offer).getByText("17 USDG",{exact:false})).toBeVisible();
 expect(within(offer).queryByText("Requested: 30 days")).not.toBeInTheDocument();
});
test("active loans never show acceptance prompts or compare against a later request",()=>{
 requestCard("active");
 expect(screen.getByRole("heading",{name:"Active loan #7"})).toBeVisible();
 expect(screen.queryByText("Loan not started.")).not.toBeInTheDocument();
 expect(screen.queryByText(/Requested:/)).not.toBeInTheDocument();
 expect(screen.getByRole("button",{name:"View loan #7"})).toBeVisible();
});
