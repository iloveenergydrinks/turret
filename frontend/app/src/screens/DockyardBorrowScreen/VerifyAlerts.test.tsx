// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
const mocks = vi.hoisted(() => {
  process.env.NEXT_PUBLIC_BORROWER_ALERTS_URL = "https://stock-alerts.example.test";
  process.env.NEXT_PUBLIC_ISOLATED_ALERTS_JSON = JSON.stringify([
    { engine: "0x3333333333333333333333333333333333333333", symbol: "CASHCAT", url: "https://cashcat-alerts.example.test" },
  ]);
  return { params: new URLSearchParams(), fetcher: vi.fn() };
});
vi.mock("next/navigation", () => ({ useSearchParams: () => mocks.params }));
vi.mock("@/src/dockyard-config", async original => ({ ...await original<object>(), DOCKYARD_VAULT_ADDRESS: "0x576c510e9A268B06448f67598B7BF1ed33388e20" }));
import VerifyAlerts from "@/src/app/(protocol)/alerts/verify/page";
const engine = "0x3333333333333333333333333333333333333333";
const token = "ab".repeat(32);
const capabilities = { protocol: "isolated", vault: engine, collateral: "0x020bfC650A365f8BB26819deAAbF3E21291018b4" };
beforeEach(() => {
  mocks.params = new URLSearchParams({ engine });
  window.history.replaceState(null, "", `/alerts/verify?engine=${engine}#${token}`);
  mocks.fetcher.mockReset().mockImplementation(async () => ({ ok: true, json: async () => capabilities }));
  vi.stubGlobal("fetch", mocks.fetcher);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
test("engine-scoped verification survives Strict Mode and strips token from address bar", async () => {
  render(<StrictMode><VerifyAlerts /></StrictMode>);
  expect(window.location.hash).toBe("");
  expect(window.location.search).toBe(`?engine=${engine}`);
  expect(screen.getByRole("link", { name: /Back to borrowing/ })).toHaveAttribute("href", `/borrow?engine=${engine}`);
  expect(mocks.fetcher).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: /Confirm email/ }));
  expect(await screen.findByText(/Email confirmed/)).toBeVisible();
  expect(mocks.fetcher.mock.calls[1]).toEqual(["https://cashcat-alerts.example.test/verify", expect.objectContaining({ body: JSON.stringify({ token }) })]);
});
test("unknown and duplicate engine parameters never use stock endpoint", () => {
  for (const params of [new URLSearchParams({ engine: "unknown" }), new URLSearchParams(`engine=${engine}&engine=${engine}`)]) {
    mocks.params = params;
    const view = render(<VerifyAlerts />);
    expect(screen.getByRole("button", { name: /Confirm email/ })).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent("not configured");
    view.unmount();
  }
  expect(mocks.fetcher).not.toHaveBeenCalled();
});
test("a miswired service never receives the verification token", async () => {
  mocks.fetcher.mockResolvedValue({ ok: true, json: async () => ({ ...capabilities, protocol: "stock" }) });
  render(<VerifyAlerts />);
  fireEvent.click(screen.getByRole("button", { name: /Confirm email/ }));
  await screen.findByText(/service is unavailable/);
  expect(mocks.fetcher).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(mocks.fetcher.mock.calls)).not.toContain(token);
});
test("missing token cannot submit; an interrupted request remains retryable", async () => {
  window.history.replaceState(null, "", `/alerts/verify?engine=${engine}`);
  const view = render(<VerifyAlerts />);
  expect(screen.getByRole("button", { name: /Confirm email/ })).toBeDisabled();
  expect(screen.getByRole("status")).toHaveTextContent(/incomplete/);
  view.unmount();
  window.history.replaceState(null, "", `/alerts/verify?engine=${engine}#${token}`);
  mocks.fetcher.mockRejectedValue(new Error("offline"));
  render(<VerifyAlerts />);
  fireEvent.click(screen.getByRole("button", { name: /Confirm email/ }));
  await waitFor(() => expect(screen.getByRole("button", { name: /Confirm email/ })).toBeEnabled());
  expect(screen.queryByText(/Email confirmed/)).not.toBeInTheDocument();
});
