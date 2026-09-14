// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import {render,screen,cleanup,fireEvent} from '@testing-library/react';
import {test,expect,vi,afterEach} from 'vitest';
const wallet=vi.hoisted(()=>({address:'0xabc' as string|null,connected:true,wrongChain:false,facts:{} as Record<string,unknown>}));
vi.mock('./useBorrowWallet',()=>({useBorrowWallet:()=>wallet}));
vi.mock('./PoolMarketStatus',()=>({PoolMarketStatus:({market}:any)=><tr><td>{market.symbol}</td></tr>}));
import {PoolLoanDirectory} from './PoolLoanDirectory';
const markets=['AAPL','NVDA'].map((symbol,i)=>({symbol,engine:'0x'+String(i+1).repeat(40),collateral:'0x'+String(i+3).repeat(40),chainId:4663,admission:'active'}));
afterEach(()=>{cleanup();vi.unstubAllGlobals();wallet.address='0xabc';wallet.connected=true;wallet.facts={};});
function mount(){vi.stubGlobal('fetch',vi.fn().mockResolvedValue({ok:true,json:async()=>({markets})}));return render(<PoolLoanDirectory/>);}
test('empty wallets see every market until they explicitly select the owned filter',async()=>{
 wallet.facts=Object.fromEntries(markets.map(m=>[m.engine,{balance:0n}]));mount();await screen.findByText('AAPL');expect(screen.getByText('NVDA')).toBeVisible();const toggle=screen.getByRole('checkbox',{name:'Only assets I own'});expect(toggle).not.toBeChecked();fireEvent.click(toggle);expect(screen.queryByText('AAPL')).not.toBeInTheDocument();fireEvent.click(screen.getByRole('button',{name:'Show all markets'}));expect(screen.getByText('AAPL')).toBeVisible();expect(toggle).not.toBeChecked();
});
test('connected holders still see all markets by default and can narrow the list',async()=>{
 wallet.facts={[markets[0]!.engine]:{balance:1n},[markets[1]!.engine]:{balance:0n}};mount();await screen.findByText('NVDA');fireEvent.click(screen.getByRole('checkbox'));expect(screen.getByText('AAPL')).toBeVisible();expect(screen.queryByText('NVDA')).not.toBeInTheDocument();
});
test('disconnected visitors see all markets with the filter off and disabled',async()=>{
 wallet.address=null;wallet.connected=false;mount();await screen.findByText('AAPL');expect(screen.getByRole('checkbox')).not.toBeChecked();expect(screen.getByRole('checkbox')).toBeDisabled();expect(screen.getByText('NVDA')).toBeVisible();
});
test('unknown balances cannot silently hide markets when filtered',async()=>{
 wallet.facts={[markets[0]!.engine]:null,[markets[1]!.engine]:{balance:0n}};mount();await screen.findByText('AAPL');fireEvent.click(screen.getByRole('checkbox'));expect(screen.getByText('AAPL')).toBeVisible();
});
