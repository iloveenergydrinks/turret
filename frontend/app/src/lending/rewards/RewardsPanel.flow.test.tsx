// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
const m=vi.hoisted(()=>({client:{},wallet:{} as any,refreshWallet:vi.fn(),deployment:{pool:'0x2222222222222222222222222222222222222222',address:'0x3333333333333333333333333333333333333333'},read:vi.fn(),send:vi.fn(),settle:vi.fn(),account:{address:'0x1111111111111111111111111111111111111111',chainId:4663}}));
vi.mock('wagmi',()=>({useAccount:()=>m.account,usePublicClient:()=>m.client,useWalletClient:()=>({data:m.wallet,refetch:m.refreshWallet})}));
vi.mock('./client',()=>({rewardsForPool:()=>m.deployment,readRewards:m.read}));
vi.mock('./transactions',async orig=>({...await orig<object>(),sendReward:m.send,settleReward:m.settle}));
import {RewardsPanel} from './RewardsPanel';
const hash=`0x${'ab'.repeat(32)}` as const;
const initial=()=>({account:m.account.address,blockNumber:20n,staked:0n,stakedAssets:0n,earned:0n,totalStaked:0n,start:1n,end:9999999999n,budget:1n,finalized:false,walletShares:1000000000000n,allowance:0n,active:true,acceptingStake:true,dailyEmission:1n});
let state=initial();
beforeEach(()=>{vi.clearAllMocks();m.wallet={};m.refreshWallet.mockResolvedValue({data:{recovered:true}});localStorage.clear();m.account.chainId=4663;state=initial();m.read.mockImplementation(async()=>({...state}));m.send.mockImplementation(async args=>{args.phase(args.action);if(args.action==='approve')state.allowance=args.amount;if(args.action==='stake'){state.staked=state.walletShares;state.walletShares=0n;}return {transactionHash:hash,blockNumber:21n};});});
afterEach(cleanup);
const show=()=>render(<RewardsPanel pool="pool" depositConfirmed refreshKey={hash}/>);
async function review(){await screen.findByRole('button',{name:'Continue reward activation'});fireEvent.click(screen.getByRole('button',{name:'Continue reward activation'}));}
it('does not confuse an active campaign with activated rewards for an existing lender',async()=>{show();expect(await screen.findByText('TURRET rewards are not activated for your position.')).toBeVisible();expect(screen.queryByText(/Rewards are accruing/)).not.toBeInTheDocument();expect(screen.getByText(/shares from earlier deposits too/)).toBeVisible();});
it('explains both confirmations, then proceeds from approval to activation in one flow',async()=>{show();await review();expect(screen.getByText(/Up to two wallet confirmations/)).toBeVisible();fireEvent.click(screen.getByRole('button',{name:'Activate rewards in wallet'}));expect(await screen.findByText('TURRET rewards activated. Your entire current pool position is included.')).toBeVisible();expect(m.send.mock.calls.map(([x])=>x.action)).toEqual(['approve','stake']);});
it('skips already sufficient approval',async()=>{state.allowance=state.walletShares;show();await review();fireEvent.click(screen.getByRole('button',{name:'Activate rewards in wallet'}));await waitFor(()=>expect(m.send).toHaveBeenCalledTimes(1));expect(m.send.mock.calls[0]?.[0].action).toBe('stake');});
it('does not claim completion when activation is rejected after approval',async()=>{m.send.mockImplementation(async a=>{if(a.action==='stake')throw {code:4001};state.allowance=a.amount;return {transactionHash:hash};});show();await review();fireEvent.click(screen.getByRole('button',{name:'Activate rewards in wallet'}));expect(await screen.findByRole('alert')).toHaveTextContent('Your USDG stays lent');expect(screen.queryByText(/entire current pool position is included/)).not.toBeInTheDocument();expect(screen.getByRole('button',{name:'Continue reward activation'})).toBeEnabled();});
it('includes a partial prior stake without falsely saying all shares earn rewards',async()=>{state.staked=5n;show();expect(await screen.findByText(/Only part of your position earns TURRET/)).toBeVisible();});
it('does not offer activation after campaign end',async()=>{state.acceptingStake=false;state.active=false;show();expect(await screen.findByText('Campaign ended or stopped. New rewards are not accruing.')).toBeVisible();expect(screen.queryByRole('button',{name:'Continue reward activation'})).not.toBeInTheDocument();});
it('does not display old fully activated balances as completion for a newer deposit',async()=>{state.staked=5n;state.walletShares=0n;render(<RewardsPanel pool="pool" depositConfirmed depositBlock={30n}/>);await waitFor(()=>expect(m.read).toHaveBeenCalled());expect(screen.queryByText(/entire current pool position is included/)).not.toBeInTheDocument();expect(screen.getByText('Checking your reward activation…')).toBeVisible();});
it('restores an interrupted transaction after reload and blocks duplicate activation',async()=>{localStorage.setItem(`turret:rewards:4663:pool:${m.account.address}`,JSON.stringify({action:'stake',account:m.account.address,to:'0x3333333333333333333333333333333333333333',data:'0x1234',afterBlock:'19',hash}));show();expect(await screen.findByRole('button',{name:'Check rewards transaction'})).toBeEnabled();expect(screen.getByRole('button',{name:'Continue reward activation'})).toBeDisabled();expect(m.send).not.toHaveBeenCalled();});
it('keeps unavailable reads distinct from an empty or activated position',async()=>{m.read.mockRejectedValue(Error('offline'));show();expect(await screen.findByRole('alert')).toHaveTextContent('Rewards could not be checked');expect(screen.queryByRole('button',{name:'Continue reward activation'})).not.toBeInTheDocument();});
it('does not enable actions on the wrong chain',async()=>{m.account.chainId=1;show();expect(screen.getByText(/Connect your wallet on Robinhood Chain/)).toBeVisible();expect(m.read).not.toHaveBeenCalled();});

it.each(['activate','unstake','claim'])('recovers a missing wallet client for %s',async action=>{
 m.wallet=undefined;state.staked=1n;state.earned=1n;show();
 if(action==='activate')await review();else fireEvent.click(await screen.findByRole('button',{name:action==='unstake'?'Return shares to withdraw':'Claim TURRET'}));
 const button=screen.getByRole('button',{name:action==='activate'?'Activate rewards in wallet':'Confirm in wallet'});expect(button).toBeEnabled();fireEvent.click(button);
 await waitFor(()=>expect(m.send).toHaveBeenCalled());expect(m.refreshWallet).toHaveBeenCalledTimes(1);expect(m.send.mock.calls[0][0].wallet).toEqual({recovered:true});
});
it('shows wallet recovery failure without sending rewards transactions',async()=>{
 m.wallet=undefined;m.refreshWallet.mockResolvedValue({data:undefined});show();await review();fireEvent.click(screen.getByRole('button',{name:'Activate rewards in wallet'}));
 expect(await screen.findByRole('alert')).toHaveTextContent('Could not connect to your wallet');expect(m.send).not.toHaveBeenCalled();
});
