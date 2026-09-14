// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import {cleanup,render,screen,within} from '@testing-library/react';
import {afterEach,expect,test} from 'vitest';
import {BorrowNavigation} from './BorrowNavigation';
afterEach(cleanup);
test('keeps three loan types with memecoins under P2P',()=>{
 render(<BorrowNavigation active="p2p"/>);
 const nav=within(screen.getByRole('navigation',{name:'Loan types'}));
 expect(nav.getAllByRole('link').map(link => link.textContent)).toEqual(['P2P stocks and memes', 'P2P NFTs', 'Pool loans']);
 expect(nav.getByRole('link',{name:'Pool loans'})).toHaveAttribute('href','/borrow/pools');
 expect(nav.getByRole('link',{name:'P2P stocks and memes'})).toHaveAttribute('aria-current','page');
 expect(nav.getByRole('link',{name:'P2P NFTs'})).toHaveAttribute('href','/borrow/nfts');
 expect(nav.queryByRole('link',{name:'Memecoin loans'})).not.toBeInTheDocument();
});
