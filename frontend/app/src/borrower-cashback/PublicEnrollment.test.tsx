// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import {afterEach,expect,test,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {EnrollmentControl} from './PublicEnrollment';
import {readPublicEnrollment,submitPublicEnrollment,verifyPublicEnrollment} from './enrollment';
vi.mock('./enrollment',()=>({readPublicEnrollment:vi.fn(),submitPublicEnrollment:vi.fn(),verifyPublicEnrollment:vi.fn()}));
afterEach(()=>{cleanup();vi.clearAllMocks();localStorage.clear();});
const state={address:'0x3333333333333333333333333333333333333333',joined:false,eligible:true,paused:false,startsAt:1000,endsAt:100000,now:2000,slots:40,excluded:false};
const props={account:'0x1111111111111111111111111111111111111111' as const,engine:'0x2222222222222222222222222222222222222222' as const,chainId:4663,
 config:{chainId:4663,rewardToken:'0x4444444444444444444444444444444444444444',deployment:{address:state.address,runtimeHash:`0x${'1'.repeat(64)}`,publicEnrollment:true}},
 client:{waitForTransactionReceipt:vi.fn(async()=>({status:'success'}))} as any,wallet:{} as any,onJoined:vi.fn(),onBusyChange:vi.fn()};
test('public enrollment requires an explicit review and confirms only after the receipt',async()=>{
 vi.mocked(readPublicEnrollment).mockResolvedValue(state as any);vi.mocked(submitPublicEnrollment).mockResolvedValue(`0x${'2'.repeat(64)}`);vi.mocked(verifyPublicEnrollment).mockResolvedValue({...state,joined:true} as any);
 render(<EnrollmentControl {...props}/>);await waitFor(()=>expect(screen.getByRole('button',{name:'Join campaign'})).toBeEnabled());
 fireEvent.click(screen.getByRole('button',{name:'Join campaign'}));expect(submitPublicEnrollment).not.toHaveBeenCalled();
 expect(screen.getByText(/shared 25 USDG cashback cap/)).toBeVisible();fireEvent.click(screen.getByRole('button',{name:'Confirm enrollment'}));
 await screen.findByText('Enrolled · 25 USDG wallet cap');expect(verifyPublicEnrollment).toHaveBeenCalled();expect(props.onJoined).toHaveBeenCalledTimes(1);
});
test('an exhausted budget disables joining without implying a wallet reservation',async()=>{
 vi.mocked(readPublicEnrollment).mockResolvedValue({...state,slots:0} as any);render(<EnrollmentControl {...props}/>);
 expect(await screen.findByRole('button',{name:'Fully reserved'})).toBeDisabled();expect(submitPublicEnrollment).not.toHaveBeenCalled();
});

test('recovers a missing enrollment wallet after review',async()=>{
 vi.mocked(readPublicEnrollment).mockResolvedValue(state as any);vi.mocked(submitPublicEnrollment).mockResolvedValue(`0x${'2'.repeat(64)}`);vi.mocked(verifyPublicEnrollment).mockResolvedValue({...state,joined:true} as any);
 const refreshWallet=vi.fn(async()=>({data:{recovered:true}}));render(<EnrollmentControl {...props} {...{wallet:undefined,refreshWallet} as any}/>);
 await waitFor(()=>expect(screen.getByRole('button',{name:'Join campaign'})).toBeEnabled());fireEvent.click(screen.getByRole('button',{name:'Join campaign'}));
 const button=screen.getByRole('button',{name:'Confirm enrollment'});expect(button).toBeEnabled();fireEvent.click(button);
 await screen.findByText('Enrolled · 25 USDG wallet cap');expect(refreshWallet).toHaveBeenCalledTimes(1);expect(submitPublicEnrollment).toHaveBeenCalledWith(expect.objectContaining({wallet:{recovered:true}}));
});
test('shows enrollment connection failure without submitting',async()=>{
 vi.mocked(readPublicEnrollment).mockResolvedValue(state as any);const refreshWallet=vi.fn(async()=>({data:undefined}));render(<EnrollmentControl {...props} {...{wallet:undefined,refreshWallet} as any}/>);
 await waitFor(()=>expect(screen.getByRole('button',{name:'Join campaign'})).toBeEnabled());fireEvent.click(screen.getByRole('button',{name:'Join campaign'}));fireEvent.click(screen.getByRole('button',{name:'Confirm enrollment'}));
 await screen.findByText(/Could not connect to your wallet/);expect(submitPublicEnrollment).not.toHaveBeenCalled();expect(localStorage.length).toBe(0);
});
