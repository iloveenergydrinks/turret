// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import {cleanup,fireEvent,render,screen,waitFor,act} from '@testing-library/react';
import {afterEach,beforeEach,expect,test,vi} from 'vitest';
import type {Deployment} from '../../p2p/client';
const api=vi.hoisted(()=>({load:vi.fn(),sign:vi.fn()}));
vi.mock('../../p2p/requests',async original=>({...await original<typeof import('../../p2p/requests')>(),loadBorrowerRequests:api.load,signRequestAction:api.sign}));
vi.mock('./CollateralMarketPrice',()=>({CollateralMarketPrice:()=>null,hasWeekendPrices:()=>false}));
import {BorrowerRequests} from './BorrowerRequests';
import {CollateralLogo} from './CollateralLogo';
import logos from '../../p2p/collateral-logos.json';
const borrower='0x1111111111111111111111111111111111111111' as const,lender='0x2222222222222222222222222222222222222222' as const;
const market={address:'0x3333333333333333333333333333333333333333',version:3,chainId:4663,loanDecimals:6,collateralDecimals:18,collateralSymbol:'AAPL',loanSymbol:'USDG',collateralToken:borrower,chainName:'Robinhood Chain',rpcUrl:'/api/p2p-rpc',loanToken:lender,runtimeHash:`0x${'a'.repeat(64)}`,startBlock:'1'} as Deployment;
const terms={principal:'150000000',collateral:'6000000000000000000',interest:'20000000',durationDays:7,expiresAt:Math.floor(Date.now()/60000)*60+86400};
const request={id:'request',sequence:1,revision:1,market:market.address,chainId:4663,borrower,createdAt:1,status:'open',acceptedProposalId:null,proposals:[],terms};
const saved={...request,revision:2,proposals:[{id:'new',lender,terms,cancelled:false,fundedOffer:null,createdAt:2}]};
const fund=vi.fn();
function mount(){return render(<BorrowerRequests markets={[market]} account={lender} provider={{request:vi.fn(),on:vi.fn(),removeListener:vi.fn()}} intent="lend" onFund={fund} onRequest={vi.fn()}/>);}
async function review(funding=true){await screen.findByText('AAPL borrowing request');fireEvent.click(screen.getByText('Offer to lend'));if(funding)fireEvent.click(screen.getByRole('checkbox',{name:/Fund this proposal now/}));fireEvent.click(screen.getByRole('button',{name:'Review proposal'}));}
function consent(){fireEvent.click(screen.getByRole('checkbox',{name:/I accept that my funds/}));}
beforeEach(()=>{vi.clearAllMocks();api.load.mockResolvedValue({requests:[request],nextCursor:null});api.sign.mockResolvedValue(saved);});
afterEach(cleanup);
test('proposal-only remains the default and never starts funding',async()=>{mount();await review(false);fireEvent.click(screen.getByRole('button',{name:'Sign and publish proposal'}));await waitFor(()=>expect(api.sign).toHaveBeenCalledOnce());expect(fund).not.toHaveBeenCalled();});
test('funding requires consent and continues with the exact new proposal once',async()=>{mount();await review();const button=screen.getByRole('button',{name:'Propose and fund now'});expect(button).toBeDisabled();consent();fireEvent.click(button);fireEvent.click(button);await waitFor(()=>expect(fund).toHaveBeenCalledOnce());expect(api.sign).toHaveBeenCalledOnce();expect(fund).toHaveBeenCalledWith(expect.objectContaining({proposalId:'new',requestId:'request',borrower,principal:150000000n,collateral:6000000000000000000n,interest:20000000n}),true);});
test('rejected signature never funds',async()=>{api.sign.mockRejectedValue(Error('User declined'));mount();await review();consent();fireEvent.click(screen.getByRole('button',{name:'Propose and fund now'}));await screen.findByText('User declined');expect(fund).not.toHaveBeenCalled();});
test('unexpected saved terms fail closed',async()=>{api.sign.mockResolvedValue({...saved,proposals:[{...saved.proposals[0],terms:{...terms,interest:'1'}}]});mount();await review();consent();fireEvent.click(screen.getByRole('button',{name:'Propose and fund now'}));await screen.findByRole('alert');expect(fund).not.toHaveBeenCalled();});
test('leaving the board during signature prevents automatic funding',async()=>{let resolve:(value:unknown)=>void=()=>{};api.sign.mockReturnValue(new Promise(r=>{resolve=r;}));const view=mount();await review();consent();fireEvent.click(screen.getByRole('button',{name:'Propose and fund now'}));view.unmount();await act(async()=>resolve(saved));expect(fund).not.toHaveBeenCalled();});
test('editing reviewed terms resets consent',async()=>{mount();await review();consent();fireEvent.change(screen.getByLabelText('USDG to borrow'),{target:{value:'160'}});fireEvent.click(screen.getByRole('button',{name:'Review proposal'}));expect(screen.getByRole('button',{name:'Propose and fund now'})).toBeDisabled();});
test('logos match contract address and recover from image failure',()=>{const [key,src]=Object.entries(logos)[0]!;const [chainId,collateralToken]=key.split(':');const view=render(<CollateralLogo market={{...market,chainId:Number(chainId) as 4663,collateralToken:collateralToken as `0x${string}`}}/>);const img=view.container.querySelector('img')!;expect(img).toHaveAttribute('src',src);fireEvent.error(img);expect(view.container.querySelector('img')).toBeNull();expect(view.container).toHaveTextContent('AA');view.rerender(<CollateralLogo market={market}/>);expect(view.container.querySelector('img')).toBeNull();});
