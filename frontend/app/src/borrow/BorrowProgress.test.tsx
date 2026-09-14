// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { afterEach, expect, test } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { BorrowProgress } from './BorrowProgress';
afterEach(cleanup);
test('approval completion advances the persistent steps without claiming that USDG has arrived', () => {
  const base = { connected: true, wrongChain: false, amountReady: true, requiresApproval: true,
    approvalReady: false, submitted: false, confirmed: false, symbol: 'AAPL' };
  const view = render(<BorrowProgress {...base} />);
  expect(screen.getByRole('status')).toHaveTextContent('3 steps remaining');
  expect(screen.getByRole('navigation').querySelector('details')).not.toHaveAttribute('open');
  fireEvent.click(screen.getByRole('navigation').querySelector('summary')!);
  expect(screen.getAllByText('Approve AAPL').find(node => node.closest('li'))!.closest('li')).toHaveAttribute('aria-current', 'step');
  view.rerender(<BorrowProgress {...base} approvalReady />);
  expect(screen.getAllByText('Review and sign loan').find(node => node.closest('li'))!.closest('li')).toHaveAttribute('aria-current', 'step');
  expect(screen.getAllByText('Receive USDG').find(node => node.closest('li'))!.closest('li')).toHaveAttribute('data-state', 'upcoming');
  view.rerender(<BorrowProgress {...base} approvalReady submitted />);
  expect(screen.getAllByText('Receive USDG').find(node => node.closest('li'))!.closest('li')).toHaveAttribute('aria-current', 'step');
  expect(screen.getByText('1 step remaining')).toBeVisible();
  view.rerender(<BorrowProgress {...base} approvalReady submitted confirmed />);
  expect(screen.getByText('Loan confirmed')).toBeVisible();
});
