// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
const mocks = vi.hoisted(() => {
  process.env.NEXT_PUBLIC_BORROWER_ALERTS_URL = "https://alerts.example.test";
  process.env.NEXT_PUBLIC_ISOLATED_ALERTS_JSON = JSON.stringify([
    { engine: "0x3333333333333333333333333333333333333333", symbol: "CASHCAT", url: "https://cashcat-alerts.example.test" },
    { engine: "0x4444444444444444444444444444444444444444", symbol: "PONS", url: "https://pons-alerts.example.test" },
  ]);
  return { sign: vi.fn(), request: vi.fn() };
});
vi.mock("wagmi", () => ({ useSignMessage: () => ({ signMessageAsync: mocks.sign }) }));
vi.mock("@/src/dockyard-config", async original => ({ ...await original<object>(), DOCKYARD_VAULT_ADDRESS: "0x576c510e9A268B06448f67598B7BF1ed33388e20" }));
import { BorrowerAlerts } from "./BorrowerAlerts";
const address = "0x1111111111111111111111111111111111111111";
const nonce = "ab".repeat(32);
const challenge = {
  id: nonce,
  message:
    `${window.location.origin} requests Dockyard borrower alert access.\nWallet: ${address}\nChain ID: 4663\nVault: 0x576c510e9A268B06448f67598B7BF1ed33388e20\nNonce: ${nonce}\nExpires: ${
      new Date(Date.now() + 300000).toISOString()
    }\nThis signature only manages notifications. It authorizes no token approvals or transactions.`,
};
function response(value: unknown, ok = true) {
  return { ok, json: async () => value };
}
beforeEach(() => {
  mocks.sign.mockReset().mockResolvedValue("0xsignature");
  mocks.request.mockReset().mockImplementation(async (url: string, options: RequestInit = {}) => {
    if (url.endsWith("/capabilities")) return response({ email: true, telegram: true, monitorReady: true,
      protocol: "stock", vault: "0x576c510e9A268B06448f67598B7BF1ed33388e20" });
    if (url.endsWith("/challenge")) return response(challenge);
    if (url.endsWith("/session")) return response({ session: "session" });
    if (options.method === "POST" && url.endsWith("/subscriptions")) return response({ sent: true });
    return response([]);
  });
  vi.stubGlobal("fetch", mocks.request);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
async function login() {
  await waitFor(() => expect(screen.getByRole("button", { name: /Verify wallet/ })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: /Verify wallet/ }));
  await screen.findByText(/Wallet verified/);
}
test("disconnected wallet cannot subscribe and sees best-effort caveat", async () => {
  render(<BorrowerAlerts />);
  expect(screen.getByText(/Connect your wallet to manage alerts/)).toBeVisible();
  expect(screen.queryByRole("button", { name: /Send confirmation/ })).not.toBeInTheDocument();
  expect(screen.getByText(/Alerts can be delayed or missed/)).toBeVisible();
});
test("provider outage does not show alerts enabled", async () => {
  mocks.request.mockRejectedValue(new Error("offline"));
  render(<BorrowerAlerts address={address} />);
  expect(await screen.findByText(/Off-site alerts are currently unavailable/)).toBeVisible();
  expect(screen.queryByText(/connected$/)).not.toBeInTheDocument();
});
test("missing risk data keeps verified alert settings available with a precise warning", async () => {
  const original = mocks.request.getMockImplementation()!;
  mocks.request.mockImplementation((url: string, options: RequestInit) => url.endsWith("/capabilities")
    ? response({ email: true, telegram: false, monitorReady: false, monitorOperational: true,
      monitorReason: "liveness_unavailable", protocol: "stock", vault: "0x576c510e9A268B06448f67598B7BF1ed33388e20" })
    : original(url, options));
  render(<BorrowerAlerts address={address} />);
  expect(await screen.findByRole("alert")).toHaveTextContent("Current liquidation-risk checks are unavailable");
  expect(screen.queryByText(/The alert monitor is unavailable/)).not.toBeInTheDocument();
  await login();
  expect(screen.getByRole("button", { name: "Send confirmation email" })).toBeEnabled();
});
test("a stopped monitor still blocks new subscriptions and preserves management access", async () => {
  const original = mocks.request.getMockImplementation()!;
  mocks.request.mockImplementation((url: string, options: RequestInit) => url.endsWith("/capabilities")
    ? response({ email: true, telegram: false, monitorReady: false, monitorOperational: false,
      monitorReason: "unavailable", protocol: "stock", vault: "0x576c510e9A268B06448f67598B7BF1ed33388e20" })
    : original(url, options));
  render(<BorrowerAlerts address={address} />);
  expect(await screen.findByRole("alert")).toHaveTextContent("The alert monitor is unavailable");
  await login();
  expect(screen.getByRole("button", { name: "Send confirmation email" })).toBeDisabled();
});
test("wallet signature precedes email confirmation and pending is not called connected", async () => {
  render(<BorrowerAlerts address={address} />);
  await login();
  fireEvent.change(screen.getByLabelText("Email address"), { target: { value: "owner@example.com" } });
  fireEvent.click(screen.getByRole("button", { name: "Send confirmation email" }));
  expect(await screen.findByText(/Confirmation email queued/)).toBeVisible();
  expect(screen.queryByText("Email connected")).not.toBeInTheDocument();
  expect(mocks.sign).toHaveBeenCalledWith({ message: challenge.message });
});
test("unrelated signature challenge is rejected before prompting wallet", async () => {
  mocks.request.mockImplementation(async (url: string) =>
    response(
      url.endsWith("/challenge")
        ? { ...challenge, message: "Approve some other service" }
        : { email: true, monitorReady: true, protocol: "stock", vault: "0x576c510e9A268B06448f67598B7BF1ed33388e20" },
    )
  );
  render(<BorrowerAlerts address={address} />);
  fireEvent.click(screen.getByRole("button", { name: /Verify wallet/ }));
  expect(await screen.findByRole("alert")).toHaveTextContent("does not match this site");
  expect(mocks.sign).not.toHaveBeenCalled();
});
test("switching wallets clears session and email form", async () => {
  const view = render(<BorrowerAlerts address={address} />);
  await login();
  fireEvent.change(screen.getByLabelText("Email address"), { target: { value: "owner@example.com" } });
  view.rerender(<BorrowerAlerts address="0x2222222222222222222222222222222222222222" />);
  expect(screen.queryByText(/Wallet verified/)).not.toBeInTheDocument();
  expect(screen.queryByLabelText("Email address")).not.toBeInTheDocument();
});
test("unknown engine never requests stock alerts", () => {
  render(<BorrowerAlerts address={address} engine="0x5555555555555555555555555555555555555555" />);
  expect(screen.getByRole("button", { name: /Verify wallet/ })).toBeDisabled();
  expect(mocks.request).not.toHaveBeenCalled();
});
test("late challenge after wallet switch never prompts the old wallet", async () => {
  let finish: (value: unknown) => void = () => {};
  const original = mocks.request.getMockImplementation()!;
  mocks.request.mockImplementation((url: string, options: RequestInit) => url.endsWith("/challenge")
    ? new Promise(resolve => { finish = resolve; }) : original(url, options));
  const view = render(<BorrowerAlerts address={address} />);
  fireEvent.click(screen.getByRole("button", { name: /Verify wallet/ }));
  await waitFor(() => expect(mocks.request.mock.calls.some(([url]) => url.endsWith("/challenge"))).toBe(true));
  view.rerender(<BorrowerAlerts address="0x2222222222222222222222222222222222222222" />);
  finish(response(challenge));
  await waitFor(() => expect(screen.getByRole("button", { name: /Verify wallet/ })).toBeEnabled());
  expect(mocks.sign).not.toHaveBeenCalled();
});
test("isolated signatures bind the engine and switching markets clears consent", async () => {
  const engine = "0x3333333333333333333333333333333333333333";
  const isolatedChallenge = { ...challenge, message: challenge.message.replace("0x576c510e9A268B06448f67598B7BF1ed33388e20", engine) };
  mocks.request.mockImplementation(async (url: string) => {
    if (url.endsWith("/capabilities")) return response({ email: true, monitorReady: true, protocol: "isolated", vault: engine,
      collateral: "0x020bfC650A365f8BB26819deAAbF3E21291018b4" });
    if (url.endsWith("/challenge")) return response(isolatedChallenge);
    if (url.endsWith("/session")) return response({ session: "session" });
    return response([]);
  });
  const view = render(<BorrowerAlerts address={address} engine={engine} />);
  await login();
  expect(mocks.sign).toHaveBeenCalledWith({ message: isolatedChallenge.message });
  expect(mocks.request.mock.calls.every(([url]) => url.startsWith("https://cashcat-alerts.example.test/"))).toBe(true);
  view.rerender(<BorrowerAlerts address={address} engine="0x4444444444444444444444444444444444444444" />);
  expect(screen.queryByText(/Wallet verified/)).not.toBeInTheDocument();
});
