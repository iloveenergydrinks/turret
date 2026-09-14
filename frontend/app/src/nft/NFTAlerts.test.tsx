// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,expect,test,vi} from 'vitest';
import type {Address,EIP1193Provider} from 'viem';
import {NFTAlerts,nftAlertScope} from './NFTAlerts';
import {checkP2PAlertCapabilities} from '../p2p/alerts-api';
import type {NFTConfig} from './client';
const account='0x1111111111111111111111111111111111111111' as Address;
const config={version:1,address:'0x2222222222222222222222222222222222222222',loanToken:'0x3333333333333333333333333333333333333333',chainId:4663,loanDecimals:6,runtimeHash:`0x${'ab'.repeat(32)}`,startBlock:'1',rpcUrl:'/api/rpc',collections:[]} as NFTConfig;
const scope=nftAlertScope(config),capabilities={...scope,email:true,telegram:false,monitorReady:true,monitorOperational:true},token='cd'.repeat(32);
const response=(value:unknown)=>({ok:true,json:async()=>value});
afterEach(()=>{cleanup();vi.unstubAllGlobals();window.history.replaceState(null,'','/');});
test('NFT scope matches the backend canonical registry and excludes collection admission from consent',async()=>{
 // @ts-expect-error Backend-only ESM is imported to check the frontend consent wire format.
 const {validateNFTAlertsRegistry}=await import('../../../../services/borrower-alerts/src/nft-deployment.mjs');
 const backend=validateNFTAlertsRegistry(config);
 expect(scope.scope).toBe(backend.scope);expect(scope.markets).toEqual(backend.markets);
 expect(nftAlertScope({...config,collections:[{address:account,name:'New collection',slug:'new',image:'',enabled:true}]}).scope).toBe(scope.scope);
 expect(()=>checkP2PAlertCapabilities({...capabilities,protocol:'p2p'},scope)).toThrow();
});
test('NFT consent signs a separate message and reaches only the NFT endpoint',async()=>{
 window.history.replaceState(null,'','/p2p/nfts');
 const wallet=vi.fn(async({method})=>method==='eth_accounts'?[account]:method==='eth_chainId'?'0x1237':'0x1234');
 const fetcher=vi.fn(async(url:string)=>{
  expect(new URL(url).pathname.startsWith('/api/nft-alerts/')).toBe(true);
  if(url.endsWith('/capabilities'))return response(capabilities);
  if(url.endsWith('/challenge'))return response({id:token,message:`${window.location.origin} requests Turret NFT P2P alert access.\nWallet: ${account}\nChain ID: 4663\nMarket scope: ${scope.scope}\nNonce: ${token}\nExpires: ${new Date(Date.now()+300000).toISOString()}\nThis signature only manages notifications. It authorizes no token approvals or transactions.`});
  if(url.endsWith('/session'))return response({session:token});
  return response([]);
 });vi.stubGlobal('fetch',fetcher);
 render(<NFTAlerts config={config} account={account} provider={{request:wallet,on:vi.fn(),removeListener:vi.fn()} as EIP1193Provider}/>);
 fireEvent.click(screen.getByText('NFT loan reminders'));
 const button=screen.getByRole('button',{name:'Verify wallet for P2P alerts'});await waitFor(()=>expect(button).toBeEnabled());fireEvent.click(button);
 expect(await screen.findByLabelText('Email address')).toBeVisible();expect(wallet.mock.calls.filter(([args])=>args.method==='personal_sign')).toHaveLength(1);
});
test('NFT verification opens settings and rejects a stock service before forwarding the token',async()=>{
 window.history.replaceState(null,'',`/p2p/nfts?alerts=verify#${token}`);
 const fetcher=vi.fn(async(..._args:unknown[])=>response({...capabilities,protocol:'p2p'}));vi.stubGlobal('fetch',fetcher);
 render(<NFTAlerts config={config}/>);
 expect(window.location.hash).toBe('');expect(screen.getByRole('button',{name:'Confirm P2P email'})).toBeVisible();
 fireEvent.click(screen.getByRole('button',{name:'Confirm P2P email'}));await screen.findByText(/This link expired/);
 expect(fetcher.mock.calls.every(args=>String(args[0]).endsWith('/capabilities'))).toBe(true);
});
