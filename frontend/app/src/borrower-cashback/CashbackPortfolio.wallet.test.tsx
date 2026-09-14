// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import {afterEach,beforeEach,expect,test,vi} from 'vitest';
import {cleanup,fireEvent,render,screen} from '@testing-library/react';
import {CashbackPortfolio} from './CashbackPortfolio';
import {encodeRecovery,recoveryKey} from './recovery';
const m=vi.hoisted(()=>({preview:vi.fn(),submit:vi.fn(),verify:vi.fn(),refresh:vi.fn()}));
vi.mock('./useBorrowerCashback',()=>({useBorrowerCashback:()=>({data:undefined,error:true,fresh:false,refresh:m.refresh})}));
vi.mock('./transactions',async orig=>({...await orig<object>(),previewCashbackClaim:m.preview,submitCashbackClaim:m.submit,verifyCashbackClaim:m.verify}));
const account='0x1111111111111111111111111111111111111111' as const,engine='0x2222222222222222222222222222222222222222' as const;
const config={chainId:4663,rewardToken:engine,deployment:{address:engine,runtimeHash:`0x${'a'.repeat(64)}`}};
const claim={borrower:account,engine,cumulative:500000n,root:`0x${'b'.repeat(64)}` as `0x${string}`,proof:[]};
const client={waitForTransactionReceipt:vi.fn(async()=>({status:'success'}))} as any;
beforeEach(()=>{vi.clearAllMocks();localStorage.clear();localStorage.setItem(recoveryKey(config,account),encodeRecovery(config,account,{claims:[claim],pending:null}));m.preview.mockResolvedValue(500000n);m.submit.mockRejectedValue(Object.assign(Error('Request cancelled'),{code:4001}));});
afterEach(cleanup);
test.each([true,false])('claim recovers the wallet or shows a connection error; recovery=%s',async succeeds=>{
 const refreshWallet=vi.fn(async()=>({data:succeeds?{recovered:true}:undefined}));
 render(<CashbackPortfolio account={account} chainId={4663} config={config} client={client} {...{refreshWallet} as any}/>);
 fireEvent.click(await screen.findByRole('button',{name:'Review claim'}));const button=await screen.findByRole('button',{name:'Confirm claim in wallet'});expect(button).toBeEnabled();fireEvent.click(button);
 await screen.findByText(succeeds?'Request cancelled':/Could not connect to your wallet/);expect(refreshWallet).toHaveBeenCalledTimes(1);
 if(succeeds)expect(m.submit).toHaveBeenCalledWith(expect.objectContaining({wallet:{recovered:true}}));else expect(m.submit).not.toHaveBeenCalled();
 expect(JSON.parse(localStorage.getItem(recoveryKey(config,account))!).pending).toBeNull();
});
