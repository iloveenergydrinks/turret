// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import {render,screen,cleanup,fireEvent,waitFor} from '@testing-library/react';
import {test,expect,vi,afterEach} from 'vitest';
vi.mock('./useBorrowWallet',()=>({useBorrowWallet:()=>({address:null,connected:false,wrongChain:false,facts:{}})}));
import {PoolLoanDirectory} from './PoolLoanDirectory';
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
test('an empty registry resolves to an explicit empty state and can recover',async()=>{
 const fetcher=vi.fn().mockResolvedValueOnce({ok:true,json:async()=>({markets:[]})}).mockResolvedValueOnce({ok:true,json:async()=>({markets:[{symbol:'AAPL',admission:'active',chainId:4663,collateral:'0x'+'2'.repeat(40),engine:'0x'+'1'.repeat(40)}]})});vi.stubGlobal('fetch',fetcher);
 render(<PoolLoanDirectory/>);await screen.findByRole('heading',{name:'No pool markets are available'});
 expect(fetcher).toHaveBeenCalledWith('/borrow-pools.json',{cache:'no-store'});
 expect(screen.queryByText('Loading pool markets…')).not.toBeInTheDocument();fireEvent.click(screen.getByRole('button',{name:'Retry markets'}));
 await waitFor(()=>expect(screen.getByRole('link',{name:/AAPL/})).toHaveAttribute('href','/borrow?engine=0x'+'1'.repeat(40)));
});
