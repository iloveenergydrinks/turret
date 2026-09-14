// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { createRequire } from 'node:module';
const { JSDOM } = createRequire(import.meta.url)('jsdom') as { JSDOM: new (html:string,options:{url:string}) => {window:{localStorage:Storage}} };
import { CashbackPortfolio } from './CashbackPortfolio';
const account = '0x1111111111111111111111111111111111111111';
const engine = '0x2222222222222222222222222222222222222222';
const config = { chainId: 4663, rewardToken: engine, deployment: { address: engine, runtimeHash: `0x${'a'.repeat(64)}` } };
beforeEach(() => { vi.stubGlobal('localStorage', new JSDOM('', { url:'http://localhost/' }).window.localStorage); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
test('Portfolio distinguishes unpaid estimates from confirmed interest and spendable claims', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ status: 'ready', chainId: 4663,
    distributor: engine, rewardToken: engine, fresh: true, enrollmentPaused: false,
    campaign: { startsAt: 1000, endsAt: 2000, settlementDeadline: 3000, claimDeadline: 4000, rebateBps: 5000 },
    asOf: { number: 1, hash: `0x${'b'.repeat(64)}`, timestamp: 1500 }, totalFunded: '10000000', totalCommitted: '10000000',
    accounts: [{ borrower: account, engine, startsAt: 1000, cap: '10000000', principal: '365000000', eligiblePrincipal: '365000000',
      unpaidInterest: '1000000', estimatedRebate: '500000', confirmedRebate: '250000', committedRebate: '750000',
      claimed: '0', claimable: '0', claim: null }] }) })));
  render(<CashbackPortfolio account={account} chainId={4663} config={config} />);
  expect(await screen.findByText('0.5 USDG')).toBeVisible();
  expect(screen.getByText('Estimated on unpaid interest')).toBeVisible();
  expect(screen.getByText('Confirmed after repayment')).toBeVisible();
  expect(screen.getByText('0.25 USDG')).toBeVisible();
  expect(screen.queryByRole('button', { name: 'Review claim' })).not.toBeInTheDocument();
});

test('switching wallets discards a late response for the previous borrower', async () => {
  let resolveFirst!: (value: unknown) => void;
  vi.stubGlobal('fetch', vi.fn((url: string) => url.endsWith(account)
    ? new Promise(resolve => { resolveFirst = resolve; })
    : Promise.resolve({ ok:true,json:async()=>({ status:'ready',chainId:4663,distributor:engine,rewardToken:engine,
      fresh:true,enrollmentPaused:false,campaign:{startsAt:1000,endsAt:2000,settlementDeadline:3000,claimDeadline:4000,rebateBps:5000},
      asOf:{number:1,hash:`0x${'b'.repeat(64)}`,timestamp:1500},totalFunded:'10000000',totalCommitted:'0',accounts:[] }) })));
  const {rerender}=render(<CashbackPortfolio account={account} chainId={4663} config={config}/>);
  rerender(<CashbackPortfolio account={engine} chainId={4663} config={config}/>);
  expect(await screen.findByText('This wallet has no funded borrower enrollment.')).toBeVisible();
  await act(async () => { resolveFirst({ok:false}); });
  expect(screen.queryByText('Reward updates are unavailable. Saved claims can still be checked directly on chain.')).not.toBeInTheDocument();
  expect(screen.queryByText('0.5 USDG')).not.toBeInTheDocument();
});

test('saved pending requests remain recoverable during an API outage and disappear on wallet switch', async () => {
  const {encodeRecovery,recoveryKey}=await import('./recovery');
  const claim={borrower:account as `0x${string}`,engine:engine as `0x${string}`,cumulative:500000n,root:`0x${'b'.repeat(64)}` as `0x${string}`,proof:[]};
  window.localStorage.setItem(recoveryKey(config,account),encodeRecovery(config,account,{claims:[claim],pending:{claim}}));
  vi.stubGlobal('fetch',vi.fn(async()=>{throw new Error('offline');}));
  const {rerender}=render(<CashbackPortfolio account={account} chainId={4663} config={config}/>);
  expect(await screen.findByText('Reward updates are unavailable. Saved claims can still be checked directly on chain.')).toBeVisible();
  expect(screen.getByRole('heading',{name:'Claim awaiting confirmation'})).toBeVisible();
  expect(screen.getByLabelText('Transaction hash from your wallet')).toBeVisible();
  expect(screen.getByRole('button',{name:'I cancelled the unsent request in my wallet'})).toBeVisible();
  rerender(<CashbackPortfolio account={engine} chainId={4663} config={config}/>);
  expect(screen.queryByRole('heading',{name:'Claim awaiting confirmation'})).not.toBeInTheDocument();
  expect(screen.queryByRole('button',{name:'Review claim'})).not.toBeInTheDocument();
});
