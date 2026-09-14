// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { Loan } from "../../p2p/client";
import { useDeadlineRefresh } from "./useDeadlineRefresh";

const loan = (value: Partial<Loan>) => ({ status: "open", expiresAt: 1000, dueAt: 0, ...value } as Loan);
const options = (refresh = vi.fn().mockResolvedValue(undefined)) => ({
  enabled: true, paused: false, refresh, observations: [{ now: 100, blockNumber: 1n, loans: [] as Loan[] }],
});
async function advance(milliseconds: number) {
  await act(async () => { await vi.advanceTimersByTimeAsync(milliseconds); });
}
function visibility(value: DocumentVisibilityState) {
  Object.defineProperty(document, "visibilityState", { configurable: true, value });
  act(() => { document.dispatchEvent(new Event("visibilitychange")); });
}
beforeEach(() => {
  vi.useFakeTimers();
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

test("polls without callback rerenders resetting its timer and uses the latest callback", async () => {
  const initial = options(), next = options();
  const { rerender } = renderHook(useDeadlineRefresh, { initialProps: initial });
  await advance(20_000);
  rerender(next);
  await advance(10_000);
  expect(initial.refresh).not.toHaveBeenCalled();
  expect(next.refresh).toHaveBeenCalledTimes(1);
  await advance(30_000);
  expect(next.refresh).toHaveBeenCalledTimes(2);
});

test("pauses hidden tabs and checks on resume and focus without duplicate reads", async () => {
  const props = options();
  const { unmount } = renderHook(useDeadlineRefresh, { initialProps: props });
  visibility("hidden");
  await advance(90_000);
  expect(props.refresh).not.toHaveBeenCalled();
  visibility("visible");
  act(() => window.dispatchEvent(new Event("focus")));
  await advance(0);
  expect(props.refresh).toHaveBeenCalledTimes(1);
  await advance(10_000);
  act(() => window.dispatchEvent(new Event("focus")));
  await advance(0);
  expect(props.refresh).toHaveBeenCalledTimes(2);
  unmount();
  act(() => window.dispatchEvent(new Event("focus")));
  await advance(60_000);
  expect(props.refresh).toHaveBeenCalledTimes(2);
});

test("skips pending operations and resumes polling after a read changes the paused state", async () => {
  let resolve!: () => void;
  const refresh = vi.fn().mockImplementationOnce(() => new Promise<void>(done => { resolve = done; }))
    .mockResolvedValue(undefined);
  const props = options(refresh);
  const { rerender } = renderHook(useDeadlineRefresh, { initialProps: props });
  await advance(30_000);
  expect(refresh).toHaveBeenCalledTimes(1);
  rerender({ ...props, paused: true });
  act(() => window.dispatchEvent(new Event("focus")));
  await advance(60_000);
  expect(refresh).toHaveBeenCalledTimes(1);
  // A React commit may finish before the refresh promise's finally callback.
  rerender(props);
  await act(async () => resolve());
  await advance(30_000);
  expect(refresh).toHaveBeenCalledTimes(2);
});

test("checks open expiry, grace entry and V3's extended final deadline from chain samples", async () => {
  const props = options();
  const { rerender } = renderHook(useDeadlineRefresh, { initialProps: {
    ...props, observations: [{ now: 100, blockNumber: 1n, loans: [loan({ expiresAt: 110 })] }],
  } });
  await advance(9999);
  expect(props.refresh).not.toHaveBeenCalled();
  await advance(1);
  expect(props.refresh).toHaveBeenCalledTimes(1);
  rerender({ ...props, observations: [{ now: 200, blockNumber: 2n, loans: [loan({ status: "active", dueAt: 207 })] }] });
  await advance(8000);
  expect(props.refresh).toHaveBeenCalledTimes(2);
  rerender({ ...props, observations: [{ now: 300, blockNumber: 3n, loans: [loan({ status: "active", dueAt: 100, repaymentDeadline: 312 })] }] });
  await advance(13_000);
  expect(props.refresh).toHaveBeenCalledTimes(3);
});

test("a halted chain or read failure cannot cause a tight retry loop", async () => {
  const props = options(vi.fn().mockRejectedValue(new Error("RPC unavailable")));
  renderHook(useDeadlineRefresh, { initialProps: {
    ...props, observations: [{ now: 100, blockNumber: 1n, loans: [loan({ expiresAt: 101 })] }],
  } });
  await advance(4999);
  expect(props.refresh).not.toHaveBeenCalled();
  await advance(15_001);
  expect(props.refresh).toHaveBeenCalledTimes(4);
});
