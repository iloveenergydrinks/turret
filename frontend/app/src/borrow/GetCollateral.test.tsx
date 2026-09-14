// @vitest-environment jsdom
import React from 'react';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {act,cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
const f=vi.hoisted(()=>({account:'0x1111111111111111111111111111111111111111',approve:vi.fn(),send:vi.fn(),connect:vi.fn(),wait:vi.fn(),allowance:0n,wallet:{} as any,refreshWallet:vi.fn()}));
vi.mock('../wallet/useWalletSession',()=>({useWalletSession:()=>({account:f.account,chainId:4663,connect:f.connect})}));
vi.mock('wagmi',()=>({useWalletClient:()=>({data:f.wallet,refetch:f.refreshWallet}),usePublicClient:()=>client}));
vi.mock('./useBorrowWallet',()=>({useBorrowWallet:()=>({facts:f.account?{[market.engine]:{balance:0n,collateral:0n,debt:0n,maxLtvBps:3000,timestamp:BigInt(Math.floor(Date.now()/1000))}}:{}})}));
vi.mock('./central-credit',()=>({validateCentral:(m:any)=>m,centralStatus:async()=>({ready:true,validUntil:BigInt(Math.floor(Date.now()/1000)+15),borrowingPrice:200n*10n**18n,availability:{cash:10000000n,principal:0n,debtLimit:10000000n,minimumDebt:1000000n,paused:false}})}));
vi.mock('./swap-wallet.mjs',()=>({approveSwap:(...a:any[])=>f.approve(...a),sendCollateralSwap:(...a:any[])=>f.send(...a),paymentBalance:async()=>1000000000n,paymentAllowance:async()=>f.allowance}));
const market:any={engine:'0x2222222222222222222222222222222222222222',collateral:'0x3333333333333333333333333333333333333333',symbol:'NVDA',chainId:4663,admission:'active',central:{}};
const client={readContract:vi.fn(async(p:any)=>p.functionName==='maxLtvBps'?3000:0n),waitForTransactionReceipt:(...a:any[])=>f.wait(...a)};
import {CollateralWorkspace} from './GetCollateral';
beforeEach(()=>{f.wallet={};f.refreshWallet.mockResolvedValue({data:{recovered:true}});f.allowance=0n;f.account='0x1111111111111111111111111111111111111111';f.approve.mockReset();f.send.mockReset();f.wait.mockReset();sessionStorage.clear();client.readContract.mockReset().mockImplementation(async(p:any)=>p.functionName==='maxLtvBps'?3000:0n);
 vi.stubGlobal('fetch',vi.fn(async(path:string,options:any)=>{
  if(path.endsWith('/build'))return {ok:true,json:async()=>({transaction:{}})};
  const input=JSON.parse(options.body);return {ok:true,json:async()=>({id:'test',expiresAt:Date.now()+29000,routeSummary:{tokenIn:'0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168',tokenOut:market.collateral,amountIn:input.amountIn,amountOut:'500000000000000000',timestamp:Math.floor(Date.now()/1000),route:[[{exchange:'uniswapv3'}]]}})};
 }));});
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
async function review(){render(<CollateralWorkspace market={market}/>);fireEvent.change(screen.getByLabelText('Pay with'),{target:{value:'100'}});await waitFor(()=>expect((screen.getByRole('button',{name:'Review swap'}) as HTMLButtonElement).disabled).toBe(false));fireEvent.click(screen.getByRole('button',{name:'Review swap'}));await screen.findByRole('button',{name:'Approve USDG'});}
describe('collateral workspace transaction states',()=>{
 it('previews an entered amount automatically without requesting wallet approval',async()=>{
  const {container}=render(<CollateralWorkspace market={market}/>);
  fireEvent.change(screen.getByLabelText('Pay with'),{target:{value:'100'}});
  await waitFor(()=>expect(container.querySelector('.collateral-receive output')?.textContent).toBe('0.5'),{timeout:1800});
  expect(screen.getByRole('button',{name:'Review swap'})).toBeTruthy();
  expect(screen.queryByRole('button',{name:'Approve USDG'})).toBeNull();
  expect(f.approve).not.toHaveBeenCalled();expect(f.send).not.toHaveBeenCalled();
 });

 it('keeps inputs editable and ignores an older preview after the amount changes',async()=>{
  const responses=new Map<string,(response:any)=>void>();
  vi.stubGlobal('fetch',vi.fn((_path:string,options:any)=>new Promise(resolve=>responses.set(JSON.parse(options.body).amountIn,resolve))));
  const {container}=render(<CollateralWorkspace market={market}/>);
  fireEvent.change(screen.getByLabelText('Pay with'),{target:{value:'100'}});
  await waitFor(()=>expect(responses.has('100000000')).toBe(true),{timeout:1800});
  expect((screen.getByLabelText('Pay with') as HTMLInputElement).disabled).toBe(false);
  fireEvent.change(screen.getByLabelText('Pay with'),{target:{value:'200'}});
  await waitFor(()=>expect(responses.has('200000000')).toBe(true),{timeout:1800});
  const response=(amountIn:string,amountOut:string)=>({ok:true,json:async()=>({id:amountIn,expiresAt:Date.now()+29000,routeSummary:{tokenIn:'0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168',tokenOut:market.collateral,amountIn,amountOut,timestamp:Math.floor(Date.now()/1000),route:[[{exchange:'uniswapv3'}]]}})});
  await act(async()=>responses.get('200000000')!(response('200000000','1000000000000000000')));
  expect(container.querySelector('.collateral-receive output')?.textContent).toBe('1');
  await act(async()=>responses.get('100000000')!(response('100000000','500000000000000000')));
  expect(container.querySelector('.collateral-receive output')?.textContent).toBe('1');
  fireEvent.click(screen.getByRole('button',{name:'Review swap'}));
  await screen.findByRole('button',{name:'Approve USDG'});
  expect(fetch).toHaveBeenCalledTimes(2);expect(f.approve).not.toHaveBeenCalled();
 });
 it('shows real quote output and capacity with a separate approval action',async()=>{await review();expect(screen.getByText('0.4975 NVDA')).toBeTruthy();expect(screen.getByText('10 USDG')).toBeTruthy();expect(f.approve).not.toHaveBeenCalled();});
 it('clears an old quote when the amount changes',async()=>{await review();fireEvent.change(screen.getByLabelText('Pay with'),{target:{value:'200'}});expect(screen.queryByRole('button',{name:'Approve USDG'})).toBeNull();expect(screen.getByRole('button',{name:'Review swap'})).toBeTruthy();});
 it('recovers after a wallet rejection without recording a pending transaction',async()=>{f.approve.mockImplementation(async({assertCurrent})=>{assertCurrent();throw {code:4001};});await review();fireEvent.click(screen.getByRole('button',{name:'Approve USDG'}));await screen.findByText('Request cancelled in your wallet. You can try again.');expect(sessionStorage.length).toBe(0);expect(f.send).not.toHaveBeenCalled();});
 it('retains a hash when confirmation times out and blocks duplicate submission',async()=>{f.approve.mockResolvedValue('0x'+'a'.repeat(64));f.wait.mockRejectedValue(Error('timeout'));await review();fireEvent.click(screen.getByRole('button',{name:'Approve USDG'}));await screen.findByRole('button',{name:'Check confirmation'});expect(sessionStorage.length).toBe(1);expect(screen.queryByRole('button',{name:'Approve USDG'})).toBeNull();expect(f.approve).toHaveBeenCalledTimes(1);});
 it('requires another quote after approval and never automatically swaps',async()=>{f.approve.mockResolvedValue('0x'+'b'.repeat(64));f.wait.mockResolvedValue({status:'success'});await review();fireEvent.click(screen.getByRole('button',{name:'Approve USDG'}));await screen.findByText('USDG approved. Refresh the quote to review current amounts.');expect(f.send).not.toHaveBeenCalled();expect(sessionStorage.length).toBe(0);});
 it('retries an unavailable borrowing parameter read',async()=>{f.account='';client.readContract.mockRejectedValueOnce(Error('RPC unavailable'));render(<CollateralWorkspace market={market}/>);await screen.findByText('The borrowing estimate could not be checked.');fireEvent.click(screen.getByRole('button',{name:'Retry borrowing estimate'}));await waitFor(()=>expect(screen.queryByText('The borrowing estimate could not be checked.')).toBeNull());expect(client.readContract).toHaveBeenCalledTimes(2);});
 it('does not let account A reconciliation clear account B pending state',async()=>{
  let settle:(x:any)=>void=()=>{};f.wait.mockImplementation(()=>new Promise(resolve=>{settle=resolve;}));
  const a=f.account,b='0x4444444444444444444444444444444444444444';
  const pending=(account:string)=>({hash:'0x'+'a'.repeat(64),kind:'approve',account,engine:market.engine,amount:'100',payToken:'USDG',minimum:'1',before:'0',at:Date.now()});
  sessionStorage.setItem(`turret:collateral-swap:${a}:${market.engine}`,JSON.stringify(pending(a)));
  sessionStorage.setItem(`turret:collateral-swap:${b}:${market.engine}`,JSON.stringify(pending(b)));
  const view=render(<CollateralWorkspace market={market}/>);fireEvent.click(await screen.findByRole('button',{name:'Check confirmation'}));
  f.account=b;view.rerender(<CollateralWorkspace market={market}/>);await screen.findByRole('button',{name:'Check confirmation'});
  await act(async()=>{settle({status:'reverted'});});
  expect(screen.getByRole('button',{name:'Check confirmation'})).toBeTruthy();expect(screen.queryByText('The transaction reverted. No swap was completed.')).toBeNull();expect(sessionStorage.getItem(`turret:collateral-swap:${b}:${market.engine}`)).not.toBeNull();
 });
});

it.each([false,true])('recovers missing swap wallet, already approved=%s',async approved=>{
 f.wallet=undefined;f.allowance=approved?1000000000n:0n;
 const send=approved?f.send:f.approve;send.mockRejectedValue({code:4001});
 render(<CollateralWorkspace market={market}/>);fireEvent.change(screen.getByLabelText('Pay with'),{target:{value:'100'}});
 await waitFor(()=>expect((screen.getByRole('button',{name:'Review swap'}) as HTMLButtonElement).disabled).toBe(false));fireEvent.click(screen.getByRole('button',{name:'Review swap'}));
 const button=await screen.findByRole('button',{name:approved?'Swap 100 USDG':'Approve USDG'});expect((button as HTMLButtonElement).disabled).toBe(false);fireEvent.click(button);
 await screen.findByText('Request cancelled in your wallet. You can try again.');expect(send).toHaveBeenCalledTimes(1);expect(send.mock.calls[0][0].wallet).toEqual({recovered:true});expect(sessionStorage.length).toBe(0);
});
it('shows connection failure without sending a swap approval',async()=>{
 f.wallet=undefined;f.refreshWallet.mockRejectedValue(Error('connector unavailable'));await review();fireEvent.click(screen.getByRole('button',{name:'Approve USDG'}));
 await screen.findByText(/Could not connect to your wallet/);expect(f.approve).not.toHaveBeenCalled();expect(sessionStorage.length).toBe(0);
});
