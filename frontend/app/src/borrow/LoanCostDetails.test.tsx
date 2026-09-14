// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { afterEach, expect, test } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { LoanCostDetails } from './LoanCostDetails';
afterEach(cleanup);
const day = 86400;
const campaign = { startsAt: 1000, endsAt: 1000 + 10 * day, settlementDeadline: 1000 + 40 * day,
  claimDeadline: 1000 + 70 * day, rebateBps: 5000 };
const enrollment = { startsAt: 1000, cap: 10000000n, committedRebate: 0n };

test('the selected loan period changes gross and net cost while preserving the campaign end', () => {
  function Loan() {
    const [days, setDays] = useState(30);
    return <LoanCostDetails principal={365000000n} aprBps={1000} now={1000} days={days} onDaysChange={setDays}
      campaign={campaign} enrollment={enrollment} />;
  }
  render(<Loan />);
  const field = (name: string) => screen.getByText(name).closest('div')!;
  expect(within(field('Estimated interest')).getByText('3 USDG')).toBeVisible();
  expect(within(field('Estimated cashback')).getByText('0.5 USDG')).toBeVisible();
  expect(within(field('Estimated net interest')).getByText('2.5 USDG')).toBeVisible();
  fireEvent.change(screen.getByLabelText('Estimate period'), { target: { value: '7' } });
  expect(within(field('Estimated interest')).getByText('0.7 USDG')).toBeVisible();
  expect(within(field('Estimated cashback')).getByText('0.35 USDG')).toBeVisible();
  expect(screen.getByText(/Cashback accrual ends/)).toBeVisible();
  const terms = screen.getByText(/Estimate details/).closest('details')!;
  expect(terms).not.toHaveAttribute('open');
  fireEvent.click(screen.getByText(/Estimate details/));
  expect(screen.getByText(/Pay eligible interest by/)).toBeVisible();
});
