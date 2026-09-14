// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import {render,screen,cleanup,act} from '@testing-library/react';
import {afterEach,beforeEach,expect,test,vi} from 'vitest';
const state=vi.hoisted(()=>({query:{} as Record<string,unknown>}));
vi.mock('wagmi',()=>({usePublicClient:()=>({})}));
vi.mock('@tanstack/react-query',()=>({useQuery:()=>state.query}));
import {PoolRewardsSummary} from './PoolRewardsSummary';
const pool='0x853CA2c511690A6A5beB7F16B240b9602160D97C';
const data=()=>({start:BigInt(Math.floor(Date.now()/1000)-100),end:BigInt(Math.floor(Date.now()/1000)+100),budget:1000n*10n**18n,finalized:false,expiresAt:Date.now()+120000});
beforeEach(()=>{state.query={isPending:true}});afterEach(()=>{cleanup();vi.useRealTimers()});
test('no campaign is distinct from loading or zero reward',()=>{render(<PoolRewardsSummary pool="0xnotconfigured"/>);expect(screen.getByText('No TURRET campaign')).toBeVisible();expect(screen.queryByText(/active/)).not.toBeInTheDocument()});
test('active rewards are a pool allocation with staking required',()=>{state.query={data:data()};render(<PoolRewardsSummary pool={pool}/>);expect(screen.getByText('TURRET rewards active')).toBeVisible();expect(screen.getByText(/Shared by this pool’s stakers/)).toBeVisible();expect(screen.getByText('Lend USDG, then activate rewards in the same flow.')).toBeVisible()});
test('failed refresh never keeps the active badge or rate',()=>{state.query={data:data(),isError:true};render(<PoolRewardsSummary pool={pool}/>);expect(screen.getByText('TURRET rewards unavailable')).toBeVisible();expect(screen.queryByText(/TURRET\/day/)).not.toBeInTheDocument()});
test('ends at the campaign boundary even without another network response',()=>{vi.useFakeTimers();state.query={data:data()};render(<PoolRewardsSummary pool={pool}/>);act(()=>vi.advanceTimersByTime(100001));expect(screen.getByText('TURRET campaign ended')).toBeVisible();expect(screen.queryByText(/TURRET\/day/)).not.toBeInTheDocument()});
test('stopped campaign leaves claims and unstaking available',()=>{state.query={data:{...data(),finalized:true}};render(<PoolRewardsSummary pool={pool}/>);expect(screen.getByText('TURRET campaign stopped')).toBeVisible();expect(screen.getByText(/still claim and unstake/)).toBeVisible()});
