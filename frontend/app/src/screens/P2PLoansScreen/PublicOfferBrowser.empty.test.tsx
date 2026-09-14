// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { PublicOfferBrowser } from './PublicOfferBrowser';
afterEach(cleanup);
const props = () => ({ offers: [], markets: [], assetFilter: '', onAssetChange: vi.fn(), onReview: vi.fn(), onCreate: vi.fn(), onRequest: vi.fn(), hasMore: false, loading: false, failed: false, loadMoreDisabled: false, onLoadMore: vi.fn() });
test('completed empty offers explain the next step without duplicate zero-result messages', () => {
  const p=props();render(<PublicOfferBrowser {...p}/>);
  expect(screen.getByRole('heading',{name:'No loans ready to borrow'})).toBeVisible();
  expect(screen.queryByText('No matching offers')).not.toBeInTheDocument();
  expect(screen.queryByRole('searchbox')).not.toBeInTheDocument();
  expect(screen.queryByText('Sort and filter offers')).not.toBeInTheDocument();
  expect(screen.queryByRole('button',{name:'Request your own terms'})).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button',{name:'Request a loan'}));
  expect(p.onRequest).toHaveBeenCalledOnce();
});
test('partial discovery offers a working continuation and does not claim the market is empty', () => {
  const p=props();render(<PublicOfferBrowser {...p} hasMore/>);
  expect(screen.getByRole('heading',{name:'No offers in this batch'})).toBeVisible();
  fireEvent.click(screen.getByRole('button',{name:'Load more offers'}));
  expect(p.onLoadMore).toHaveBeenCalledOnce();
  expect(screen.queryByRole('heading',{name:'No loans ready to borrow'})).not.toBeInTheDocument();
});
test('failed and pending reads do not masquerade as an empty marketplace', () => {
  const p=props();const {rerender,container}=render(<PublicOfferBrowser {...p} failed/>);
  expect(screen.getByRole('heading',{name:'We couldn’t load all offers'})).toBeVisible();
  expect(container.querySelector('.turret-empty-art')).toBeNull();
  expect(screen.queryByRole('button',{name:'Request a loan'})).not.toBeInTheDocument();
  rerender(<PublicOfferBrowser {...p} loading/>);
  expect(screen.getByRole('status',{name:'Loading public offers'})).toBeVisible();
  expect(screen.queryByRole('heading',{name:'No loans ready to borrow'})).not.toBeInTheDocument();
});
