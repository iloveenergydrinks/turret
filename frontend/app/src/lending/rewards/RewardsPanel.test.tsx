// @vitest-environment jsdom
import React from 'react';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {cleanup,render,screen} from '@testing-library/react';
import {RewardsPanel} from './RewardsPanel';
vi.mock('./campaigns.json',()=>({default:{rewardToken:'0x99d70a25Bd7e95A30e14Bcbb64752c92227de9d7',deployments:[],plannedPools:['0x853CA2c511690A6A5beB7F16B240b9602160D97C'],startsAt:0,endsAt:0}}));
vi.mock('wagmi',()=>({useAccount:()=>({}),usePublicClient:()=>undefined,useWalletClient:()=>({})}));
afterEach(cleanup);
describe('unfunded campaign',()=>{
 it('describes the plan without claiming rewards are accruing or offering a deposit action',()=>{
  render(<RewardsPanel pool="0x853CA2c511690A6A5beB7F16B240b9602160D97C"/>);
  expect(screen.getByRole('status').textContent).toContain('Not active yet');
  expect(screen.getByText(/20 million TURRET/).textContent).toContain('14 days');
  expect(screen.queryAllByRole('button')).toHaveLength(0);
 });
 it('does not advertise the campaign on the excluded silver pool',()=>{
  const {container}=render(<RewardsPanel pool="0xDbc56d30c61B90cD75c2e8D46FDBDb4CD25d9c16"/>);expect(container.textContent).toBe('');
 });
});
