import { afterEach, expect, test, vi } from 'vitest';
import { readCashback } from './client';

const borrower = '0x1111111111111111111111111111111111111111';
const engine = '0x2222222222222222222222222222222222222222';
const distributor = '0x3333333333333333333333333333333333333333';
const rewardToken = '0x4444444444444444444444444444444444444444';
const config = { chainId: 4663, rewardToken, deployment: { address: distributor, runtimeHash: `0x${'1'.repeat(64)}` } };
const response = { status: 'ready', chainId: 4663, distributor, rewardToken, fresh: true,
  campaign: { startsAt: 1000, endsAt: 2000, settlementDeadline: 3000, claimDeadline: 4000, rebateBps: 5000 },
  asOf: { number: 1, hash: `0x${'2'.repeat(64)}`, timestamp: 1500 }, totalFunded: '100000000', totalCommitted: '10000000',
  enrollmentPaused: false, accounts: [{ borrower, engine, cap: '10000000', startsAt: 1000, principal: '365000000',
    eligiblePrincipal: '365000000', unpaidInterest: '0', estimatedRebate: '0', confirmedRebate: '500000',
    committedRebate: '500000', claimed: '0', claimable: '0', claim: null }] };
afterEach(() => vi.unstubAllGlobals());

test('reads funded enrollment without treating unpublished rewards as claimable', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => response })));
  const result = await readCashback(config, borrower);
  expect(result?.accounts[0]).toMatchObject({ cap: 10000000n, confirmedRebate: 500000n, claimable: 0n });
});

test('a campaign without a deployment never requests rewards or promises cashback', async () => {
  vi.stubGlobal('fetch', () => { throw new Error('Unexpected request'); });
  expect(await readCashback({ ...config, deployment: null }, borrower)).toBeNull();
});

test('rejects responses for a different wallet, deployment or unbacked cap', async () => {
  for (const data of [
    { ...response, chainId: 1 },
    { ...response, distributor: borrower },
    { ...response, totalFunded: '1' },
    { ...response, accounts: [{ ...response.accounts[0], borrower: engine }] },
    { ...response, accounts: [{ ...response.accounts[0], claimed: '10000001' }] },
    { ...response, accounts: [{ ...response.accounts[0], claimable: '500000' }] },
  ]) {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => data })));
    await expect(readCashback(config, borrower)).rejects.toThrow();
  }
});

test('a failed rewards request does not turn into zero earned rewards', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false })));
  await expect(readCashback(config, borrower)).rejects.toThrow('unavailable');
});

test('public enrollment shares one funded wallet cap across markets and rejects excessive combined rewards', async () => {
 const publicConfig={...config,deployment:{...config.deployment,publicEnrollment:true}};
 const row={...response.accounts[0],cap:'25000000'};
 const data={...response,totalFunded:'1000000000',totalCommitted:'25000000',joined:true,publicEnrollment:{walletCap:'25000000',budgetCap:'1000000000'},
  accounts:[row,{...row,engine:'0x5555555555555555555555555555555555555555'}]};
 vi.stubGlobal('fetch',vi.fn(async()=>({ok:true,json:async()=>data})));
 expect((await readCashback(publicConfig,borrower))?.accounts).toHaveLength(2);
 vi.stubGlobal('fetch',vi.fn(async()=>({ok:true,json:async()=>({...data,accounts:data.accounts.map(r=>({...r,confirmedRebate:'20000000'}))})})));
 await expect(readCashback(publicConfig,borrower)).rejects.toThrow('Wallet reward exceeds cap');
});
