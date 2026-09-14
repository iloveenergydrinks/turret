// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { Address, EIP1193Provider } from 'viem';
import { P2PAlerts } from './P2PAlerts';
import { p2pAlertScope } from './alerts-api';
import type { Deployment } from './client';

const account='0x1111111111111111111111111111111111111111' as Address,other='0x2222222222222222222222222222222222222222' as Address;
const market={address:'0x3333333333333333333333333333333333333333',version:3,chainId:4663,chainName:'Robinhood',rpcUrl:'/api/rpc',loanToken:'0x4444444444444444444444444444444444444444',collateralToken:'0x5555555555555555555555555555555555555555',runtimeHash:`0x${'ab'.repeat(32)}`,startBlock:'1',loanSymbol:'USDG',collateralSymbol:'SLV',loanDecimals:6,collateralDecimals:18} as Deployment;
const scope=p2pAlertScope([market])!,session='cd'.repeat(32),challengeId='ab'.repeat(32);
const capabilities={protocol:'p2p',...scope,email:true,telegram:true,monitorReady:true,monitorOperational:true};
let fetcher:ReturnType<typeof vi.fn>,wallet:ReturnType<typeof vi.fn>;
let subscriptions:{channel:string;delivered:null;failed:boolean}[];
const response=(value:unknown)=>({ok:true,json:async()=>value});
beforeEach(()=>{
  window.history.replaceState(null,'','/p2p');subscriptions=[];
  fetcher=vi.fn(async(url:string,options?:RequestInit)=>{
    const path=new URL(url).pathname;
    if(path.endsWith('/capabilities'))return response(capabilities);
    if(path.endsWith('/challenge'))return response({id:challengeId,message:`${window.location.origin} requests Turret P2P alert access.\nWallet: ${account}\nChain ID: 4663\nMarket scope: ${scope.scope}\nNonce: ${challengeId}\nExpires: ${new Date(Date.now()+300000).toISOString()}\nThis signature only manages notifications. It authorizes no token approvals or transactions.`});
    if(path.endsWith('/session'))return response({session});
    if(path.endsWith('/subscriptions')&&options?.method==='GET')return response(subscriptions);
    if(path.endsWith('/subscriptions'))return response(options?.body?.toString().includes('telegram')?{url:`https://t.me/test_bot?start=${challengeId}`}:{sent:true});
    return response({verified:true});
  });
  vi.stubGlobal('fetch',fetcher);
  wallet=vi.fn(async({method})=>method==='eth_accounts'?[account]:method==='eth_chainId'?'0x1237':'0x1234');
});
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
const provider=()=>({request:wallet,on:vi.fn(),removeListener:vi.fn()} as EIP1193Provider);
test('disconnected users see consent requirements without requesting signatures',async()=>{
  render(<P2PAlerts markets={[market]}/>);
  expect(screen.getByText('Connect your wallet to manage P2P alerts.')).toBeVisible();
  await waitFor(()=>expect(fetcher).toHaveBeenCalled());expect(wallet).not.toHaveBeenCalled();
});
test('wallet verification enables separate email and Telegram confirmation flows',async()=>{
  render(<P2PAlerts account={account} provider={provider()} markets={[market]}/>);
  const button=screen.getByRole('button',{name:'Verify wallet for P2P alerts'});await waitFor(()=>expect(button).toBeEnabled());fireEvent.click(button);
  const email=await screen.findByLabelText('Email address');fireEvent.change(email,{target:{value:'me@example.test'}});
  fireEvent.click(screen.getByRole('button',{name:'Send confirmation'}));expect(await screen.findByText(/Confirmation email queued/)).toBeVisible();
  expect(fetcher.mock.calls.some(([,options])=>options?.headers&&JSON.stringify(options.headers).includes(`Bearer ${session}`))).toBe(true);
  fireEvent.click(screen.getByRole('button',{name:'Connect Telegram'}));
  expect(await screen.findByRole('link',{name:'Confirm P2P alerts in Telegram'})).toHaveAttribute('href',`https://t.me/test_bot?start=${challengeId}`);
  expect(wallet.mock.calls.filter(([args])=>args.method==='personal_sign')).toHaveLength(1);
});
test('misconfigured market scope disables signature flow',async()=>{
  fetcher.mockResolvedValue(response({...capabilities,scope:`0x${'00'.repeat(32)}`}));
  render(<P2PAlerts account={account} provider={provider()} markets={[market]}/>);
  expect(await screen.findByText(/Automatic P2P alerts are currently unavailable/)).toBeVisible();
  expect(screen.getByRole('button',{name:'Verify wallet for P2P alerts'})).toBeDisabled();expect(wallet).not.toHaveBeenCalled();
});
test('wallet change during signing never creates a session for the previous wallet',async()=>{
  let resolve!:(value:string)=>void;const signing=new Promise<string>(r=>resolve=r);
  wallet.mockImplementation(async({method})=>method==='eth_accounts'?[account]:method==='eth_chainId'?'0x1237':signing);
  const p=provider(),view=render(<P2PAlerts account={account} provider={p} markets={[market]}/>);
  const button=screen.getByRole('button',{name:'Verify wallet for P2P alerts'});await waitFor(()=>expect(button).toBeEnabled());fireEvent.click(button);
  await waitFor(()=>expect(wallet.mock.calls.some(([args])=>args.method==='personal_sign')).toBe(true));
  view.rerender(<P2PAlerts account={other} provider={p} markets={[market]}/>);resolve('0x1234');
  await waitFor(()=>expect(screen.getByRole('button',{name:'Verify wallet for P2P alerts'})).toBeEnabled());
  expect(fetcher.mock.calls.some(([url])=>url.endsWith('/session'))).toBe(false);
});
test('email verification works disconnected under Strict Mode and strips the token',async()=>{
  window.history.replaceState(null,'',`/p2p?alerts=verify#${challengeId}`);
  render(<StrictMode><P2PAlerts markets={[market]}/></StrictMode>);
  expect(window.location.hash).toBe('');fireEvent.click(screen.getByRole('button',{name:'Confirm P2P email'}));
  expect(await screen.findByText('Email confirmed. P2P loan reminders and updates are enabled.')).toBeVisible();
  expect(fetcher.mock.calls.filter(([url])=>url.endsWith('/verify'))).toHaveLength(1);
});
test('email confirmation never sends a token to an unrelated service',async()=>{
  window.history.replaceState(null,'',`/p2p?alerts=verify#${challengeId}`);fetcher.mockResolvedValue(response({...capabilities,protocol:'stock'}));
  render(<P2PAlerts markets={[market]}/>);fireEvent.click(screen.getByRole('button',{name:'Confirm P2P email'}));
  await screen.findByText(/This link expired/);expect(fetcher.mock.calls.some(([url])=>url.endsWith('/verify'))).toBe(false);
});
test('connected channels can be deleted explicitly',async()=>{
  subscriptions=[{channel:'email',delivered:null,failed:false}];
  render(<P2PAlerts account={account} provider={provider()} markets={[market]}/>);
  const button=screen.getByRole('button',{name:'Verify wallet for P2P alerts'});await waitFor(()=>expect(button).toBeEnabled());fireEvent.click(button);
  fireEvent.click(await screen.findByRole('button',{name:'Disable email P2P alerts'}));
  expect(await screen.findByText('Email P2P alerts disabled.')).toBeVisible();expect(fetcher.mock.calls.some(([,options])=>options?.method==='DELETE')).toBe(true);
});
