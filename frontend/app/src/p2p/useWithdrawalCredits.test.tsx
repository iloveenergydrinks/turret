// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import type { Address } from "viem";
import type { Loan, P2PClient, Snapshot, Deployment } from "./client";
import { useWithdrawalCredits } from "./useWithdrawalCredits";
const account = `0x${"a".repeat(40)}` as Address, other = `0x${"b".repeat(40)}` as Address;
const config = { version: 3, address: other } as Deployment;
const anchor = { number: 20n, hash: `0x${"c".repeat(64)}` };
test("discovers old credits even when the recent history has none", async () => {
  const loan = { id: 1n, loanCredits: { USDG: { beneficiary: account, nominal: 25n, available: 20n }, COLLATERAL: { beneficiary: other, nominal: 0n, available: 0n } } } as Loan;
  const creditPage = vi.fn().mockResolvedValueOnce({ loans: [], nextCursor: 40n, anchor, nominal: { USDG: 25n, COLLATERAL: 0n } })
    .mockResolvedValueOnce({ loans: [loan], nextCursor: null, anchor, nominal: { USDG: 25n, COLLATERAL: 0n } });
  const markets = [{ config, client: { creditPage } as unknown as P2PClient, own: { account, blockNumber: 20n, offers: [] } as unknown as Snapshot }];
  const view = renderHook(({ wallet }) => useWithdrawalCredits(wallet, markets), { initialProps: { wallet: account as Address | null } });
  await waitFor(() => expect(view.result.current.entries[other]?.complete).toBe(true));
  expect(view.result.current.entries[other]?.loans).toEqual([loan]);
  expect(creditPage).toHaveBeenLastCalledWith(40n, anchor);
  view.rerender({ wallet: null }); expect(view.result.current.entries).toEqual({});
});
test("failed discovery never becomes a complete empty balance and can retry", async () => {
  const creditPage = vi.fn().mockRejectedValueOnce(new Error("RPC unavailable"))
    .mockResolvedValue({ loans: [], nextCursor: null, anchor, nominal: { USDG: 0n, COLLATERAL: 0n } });
  const markets = [{ config, client: { creditPage } as unknown as P2PClient, own: { account, blockNumber: 20n } as Snapshot }];
  const view = renderHook(() => useWithdrawalCredits(account, markets));
  await waitFor(() => expect(view.result.current.entries[other]?.error).toBe("RPC unavailable"));
  expect(view.result.current.entries[other]?.complete).toBe(false);
  act(() => view.result.current.retry());
  await waitFor(() => expect(view.result.current.entries[other]?.complete).toBe(true));
});
test("an unavailable claim does not stop discovery of healthy credits on later pages", async () => {
  const unavailable = { id: 2n, loanCredits: { USDG: { beneficiary: account, nominal: 0n, available: 0n, unavailable: true }, COLLATERAL: { beneficiary: other, nominal: 0n, available: 0n } } } as Loan;
  const healthy = { id: 1n, loanCredits: { USDG: { beneficiary: account, nominal: 50n, available: 50n }, COLLATERAL: { beneficiary: other, nominal: 0n, available: 0n } } } as Loan;
  const creditPage = vi.fn().mockResolvedValueOnce({ loans: [unavailable], nextCursor: 40n, anchor, nominal: { USDG: 75n, COLLATERAL: 0n } })
    .mockResolvedValueOnce({ loans: [healthy], nextCursor: null, anchor, nominal: { USDG: 75n, COLLATERAL: 0n } });
  const markets = [{ config, client: { creditPage } as unknown as P2PClient, own: { account, blockNumber: 20n } as Snapshot }];
  const view = renderHook(() => useWithdrawalCredits(account, markets));
  await waitFor(() => expect(view.result.current.entries[other]?.loading).toBe(false));
  expect(creditPage).toHaveBeenCalledTimes(2);
  expect(view.result.current.entries[other]).toMatchObject({ complete: false, more: false, error: expect.stringContaining("total is incomplete") });
  expect(view.result.current.entries[other]?.loans).toEqual([unavailable, healthy]);
});
test("unavailable claims retain load-more at the page budget and a complete refresh removes consumed claims", async () => {
  const unknown = { id: 2n, loanCredits: { USDG: { beneficiary: account, nominal: 0n, available: 0n, unavailable: true }, COLLATERAL: { beneficiary: other, nominal: 0n, available: 0n } } } as Loan;
  const healthy = { id: 1n, loanCredits: { USDG: { beneficiary: account, nominal: 50n, available: 50n }, COLLATERAL: { beneficiary: other, nominal: 0n, available: 0n } } } as Loan;
  const creditPage = vi.fn(async (cursor: bigint) => ({ loans: cursor === 0n ? [unknown] : cursor === 1n ? [healthy] : [], nextCursor: cursor === 0n ? 20n : cursor === 1n ? null : cursor - 1n, anchor, nominal: { USDG: 75n, COLLATERAL: 0n } }));
  const markets = [{ config, client: { creditPage } as unknown as P2PClient, own: { account, blockNumber: 20n } as Snapshot }];
  const view = renderHook(() => useWithdrawalCredits(account, markets));
  await waitFor(() => expect(view.result.current.entries[other]?.more).toBe(true));
  expect(creditPage).toHaveBeenCalledTimes(20);
  expect(view.result.current.entries[other]?.error).toBeTruthy();
  act(() => view.result.current.loadMore());
  await waitFor(() => expect(view.result.current.entries[other]?.loans).toContainEqual(healthy));
  expect(view.result.current.entries[other]).toMatchObject({ complete: false, loading: false, more: false });
  creditPage.mockResolvedValue({ loans: [], nextCursor: null, anchor, nominal: { USDG: 0n, COLLATERAL: 0n } });
  act(() => view.result.current.retry());
  await waitFor(() => expect(view.result.current.entries[other]?.complete).toBe(true));
  expect(view.result.current.entries[other]?.loans).toEqual([]);
});
test("another market arriving does not restart an in-flight credit scan", async () => {
  let finish!: (value: unknown) => void;
  const creditPage = vi.fn(() => new Promise(resolve => { finish = resolve; }));
  const first = { config, client: { creditPage } as unknown as P2PClient, own: { account, blockNumber: 20n } as Snapshot };
  const secondPage = vi.fn().mockResolvedValue({ loans: [], nextCursor: null, anchor, nominal: { USDG: 0n, COLLATERAL: 0n } });
  const second = { ...first, config: { ...config, address: account }, client: { creditPage: secondPage } as unknown as P2PClient };
  const view = renderHook(({ markets }) => useWithdrawalCredits(account, markets), { initialProps: { markets: [first] } });
  view.rerender({ markets: [first, second] });
  expect(creditPage).toHaveBeenCalledTimes(1);
  await act(async () => finish({ loans: [], nextCursor: null, anchor, nominal: { USDG: 0n, COLLATERAL: 0n } }));
  await waitFor(() => expect(view.result.current.entries[other]?.complete).toBe(true));
});
test("a stalled balance check stops loading and can be retried", async () => {
  vi.useFakeTimers();
  try {
    const creditPage = vi.fn().mockImplementationOnce(() => new Promise(() => {}))
      .mockResolvedValue({ loans: [], nextCursor: null, anchor, nominal: { USDG: 0n, COLLATERAL: 0n } });
    const markets = [{ config, client: { creditPage } as unknown as P2PClient, own: { account, blockNumber: 20n } as Snapshot }];
    const view = renderHook(() => useWithdrawalCredits(account, markets));
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(view.result.current.entries[other]).toMatchObject({ loading: false, complete: false, error: expect.stringContaining("timed out") });
    await act(async () => view.result.current.retry());
    expect(view.result.current.entries[other]?.complete).toBe(true);
    view.unmount();
  } finally { vi.useRealTimers(); }
});
