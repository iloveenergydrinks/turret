// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ConnectedStaking, StakingPage } from "./StakingPage";
import { account, d, fixture } from "./fixtures.test-support";
let f: ReturnType<typeof fixture>;
let walletReady = true;
let walletRefetch: ReturnType<typeof vi.fn>;
let activeAccount: { address?: typeof account; chainId?: number };
vi.mock("wagmi", () => ({
  useAccount: () => activeAccount,
  usePublicClient: () => f.client,
  useWalletClient: () => ({ data: walletReady ? f.wallet : undefined, refetch: walletRefetch }),
  useSwitchChain: () => ({ switchChainAsync: vi.fn() }),
}));
vi.mock("connectkit", () => ({ useModal: () => ({ setOpen: vi.fn() }) }));
beforeEach(() => {
  const entries = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (k: string) => entries.get(k) ?? null, setItem: (k: string, v: string) => entries.set(k, v), removeItem: (k: string) => entries.delete(k), clear: () => entries.clear(), get length() { return entries.size; } });
  f = fixture(); walletReady = true; walletRefetch = vi.fn(async () => ({ data: f.wallet })); activeAccount = { address: account, chainId: 4663 }; localStorage.clear(); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("staking page wallet flows", () => {
  it("opens withdrawal signing when account is connected before wallet client is ready", async () => {
    walletReady = false;
    render(<ConnectedStaking deployment={d} />);
    await screen.findByLabelText("TURRET to stake");
    fireEvent.click(screen.getByRole("button", { name: "Unstake" }));
    fireEvent.change(screen.getByLabelText("TURRET to withdraw"), { target: { value: "0.5" } });
    fireEvent.click(screen.getByRole("button", { name: "Review withdrawal" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm in wallet" }));
    await waitFor(() => expect(f.provider.writeContract).toHaveBeenCalledTimes(1));
    expect(f.provider.writeContract.mock.calls[0]?.[0].functionName).toBe("unstake");
  });

  it("shows a reconnect error instead of ignoring a withdrawal when no signer can be loaded", async () => {
    walletReady = false; walletRefetch.mockResolvedValue({ data: undefined });
    render(<ConnectedStaking deployment={d} />);
    await screen.findByLabelText("TURRET to stake");
    fireEvent.click(screen.getByRole("button", { name: "Unstake" }));
    fireEvent.change(screen.getByLabelText("TURRET to withdraw"), { target: { value: "0.5" } });
    fireEvent.click(screen.getByRole("button", { name: "Review withdrawal" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm in wallet" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Disconnect and reconnect your wallet");
    expect(f.provider.writeContract).not.toHaveBeenCalled();
    expect(localStorage.length).toBe(0);
  });
  it("does not submit after the account changes while a signer is loading", async () => {
    walletReady = false;
    let resolveWallet!: (value: { data: typeof f.wallet }) => void;
    walletRefetch.mockReturnValue(new Promise(resolve => { resolveWallet = resolve; }));
    const view = render(<ConnectedStaking deployment={d} />);
    await screen.findByLabelText("TURRET to stake");
    fireEvent.click(screen.getByRole("button", { name: "Unstake" }));
    fireEvent.change(screen.getByLabelText("TURRET to withdraw"), { target: { value: "0.5" } });
    fireEvent.click(screen.getByRole("button", { name: "Review withdrawal" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm in wallet" }));
    expect(screen.getByRole("button", { name: "Checking wallet and balances…" })).toBeDisabled();
    activeAccount = {}; view.rerender(<ConnectedStaking deployment={d} />);
    await act(async () => { resolveWallet({ data: f.wallet }); });
    expect(f.provider.writeContract).not.toHaveBeenCalled();
    expect(localStorage.length).toBe(0);
  });
  it("explains subsidy recovery without exposing its budget", async () => {
    f.values.version = 2n;
    render(<ConnectedStaking deployment={{ ...d, rewardModel: "reserve-decay-v2" }} />);
    await screen.findByLabelText("TURRET to stake");
    expect(screen.getByText(/Treasury can recover unused subsidy/)).toBeVisible();
    expect(screen.queryByText("USDG distributed to staking")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Review USDG claim" })).toBeEnabled();
  });
  it("blocks actions when the recovery treasury differs from the verified treasury", async () => {
    f.values.version = 2n; f.values.recoveryTreasury = account;
    render(<ConnectedStaking deployment={{ ...d, rewardModel: "reserve-decay-v2" }} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Reward recovery treasury verification failed");
    expect(screen.queryByLabelText("TURRET to stake")).not.toBeInTheDocument();
  });
  it("shows personal streamed rewards every five seconds without exposing the reserve budget", async () => {
    vi.useFakeTimers(); f.values.earned = 0n;
    render(<ConnectedStaking deployment={{ ...d, rewardModel: "reserve-decay-v1" }} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(screen.queryByText("For all TURRET stakers")).not.toBeInTheDocument();
    expect(screen.queryByText("USDG distributed to staking")).not.toBeInTheDocument();
    expect(screen.getByText(/Updates every 5 seconds/)).toBeVisible();
    f.values.earned = 579n;
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(screen.getByText("0.000579", { selector: ".turret-reward-accessible" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Review USDG claim" })).toBeEnabled();
    // A failed lightweight read must not roll back to the older full snapshot.
    f.rpc.readContract.mockRejectedValue(Error("RPC unavailable"));
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(screen.getByText(/Live rewards could not be refreshed/)).toBeVisible();
    expect(screen.getByText("0.000579", { selector: ".turret-reward-accessible" })).toBeInTheDocument();
    expect(f.provider.writeContract).not.toHaveBeenCalled();
  });
  it("offers only withdrawals and claims for a legacy stake", async () => {
    render(<ConnectedStaking deployment={{ ...d, legacy: true }} />);
    expect(await screen.findByLabelText("TURRET to withdraw")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Stake", exact: true })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("TURRET to stake")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Go to the new staking reserve" })).toHaveAttribute("href", "/stake");
    fireEvent.change(screen.getByLabelText("TURRET to withdraw"), { target: { value: "1" } });
    fireEvent.click(screen.getByRole("button", { name: "Review withdrawal" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm in wallet" }));
    await screen.findByText(/Withdrawal confirmed/);
    expect(f.provider.writeContract.mock.calls.map(([r]) => r.functionName)).toEqual(["unstake"]);
  });
  it("refreshes pending fees automatically and separates them from claimable rewards", async () => {
    vi.useFakeTimers();
    render(<ConnectedStaking deployment={d} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    const counter = within(screen.getByRole("region", { name: "Pending USDG distribution" }));
    expect(counter.getAllByText("0.02", { exact: false }).length).toBe(2);
    f.values.fees = 0n; f.values.earned = 5_020_000n;
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
    expect(counter.queryByText("0.02", { exact: false })).not.toBeInTheDocument();
    expect(counter.getAllByText((_, e) => e?.tagName === "DD" && e.textContent === "0 USDG").length).toBe(2);
    expect(screen.getByText("Available to claim").nextElementSibling).toHaveTextContent("5.02 USDG");
    expect(f.provider.writeContract).not.toHaveBeenCalled();
  });
  it("shows public pending fees without requiring a wallet", async () => {
    activeAccount = {};
    render(<ConnectedStaking deployment={d} />);
    const counter = within(screen.getByRole("region", { name: "Pending USDG distribution" }));
    expect(await counter.findByText((_, e) => e?.tagName === "DD" && e.textContent === "0.02 USDG")).toBeVisible();
    expect(counter.queryByText("Your estimated share")).not.toBeInTheDocument();
  });
  it("keeps claims available when the informational fee read fails", async () => {
    const original = f.rpc.readContract.getMockImplementation()!;
    f.rpc.readContract.mockImplementation(async request => {
      if (request.functionName === "protocolFees") throw Error("RPC failed");
      return original(request);
    });
    render(<ConnectedStaking deployment={d} />);
    expect(await screen.findByText(/Pending fees are unavailable/)).toBeVisible();
    expect(screen.getByRole("button", { name: "Review USDG claim" })).toBeEnabled();
    expect(screen.getByText("Available to claim").nextElementSibling).toHaveTextContent("5 USDG");
  });
  it("does not offer wallet actions without a deployed staking manifest", () => {
    render(<StakingPage />);
    expect(screen.getByRole("heading", { name: "Staking is not active yet" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Connect wallet" })).not.toBeInTheDocument();
  });
  it("reviews an exact amount and completes approval followed by staking", async () => {
    render(<ConnectedStaking deployment={d} />);
    const input = await screen.findByLabelText("TURRET to stake");
    fireEvent.change(input, { target: { value: "2" } });
    fireEvent.click(screen.getByRole("button", { name: "Review stake" }));
    expect(screen.getByText(/Approval alone does not stake/)).toBeVisible();
    expect(screen.getByRole("heading", { name: "Review your stake" })).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "Confirm in wallet" }));
    await screen.findByText(/Stake confirmed\./);
    expect(f.provider.writeContract.mock.calls.map(([p]) => p.functionName)).toEqual(["approve", "stake"]);
    expect(localStorage.length).toBe(0);
  });
  it("allows a partial withdrawal without claiming USDG", async () => {
    render(<ConnectedStaking deployment={d} />);
    await screen.findByLabelText("TURRET to stake");
    fireEvent.click(screen.getByRole("button", { name: "Unstake" }));
    fireEvent.change(screen.getByLabelText("TURRET to withdraw"), { target: { value: "0.5" } });
    fireEvent.click(screen.getByRole("button", { name: "Review withdrawal" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm in wallet" }));
    await screen.findByText(/Withdrawal confirmed\./);
    expect(f.provider.writeContract.mock.calls.map(([p]) => p.functionName)).toEqual(["unstake"]);
    expect(f.provider.writeContract.mock.calls[0]?.[0].args).toEqual([500000000000000000n]);
  });
  it("keeps same-block withdrawal disabled until a fresh snapshot permits it", async () => {
    f.values.lastStakeBlock = 1n; f.values.canUnstake = false;
    render(<ConnectedStaking deployment={d} />);
    await screen.findByLabelText("TURRET to stake");
    fireEvent.click(screen.getByRole("button", { name: "Unstake" }));
    fireEvent.change(screen.getByLabelText("TURRET to withdraw"), { target: { value: "0.5" } });
    expect(screen.getByRole("button", { name: "Review withdrawal" })).toBeDisabled();
    f.values.canUnstake = true;
    fireEvent.click(screen.getByRole("button", { name: "Refresh balances" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Review withdrawal" })).toBeEnabled());
    expect(f.provider.writeContract).not.toHaveBeenCalled();
  });
  it("does not describe a zero stake as an active withdrawal delay", async () => {
    f.values.staked = 0n; f.values.canUnstake = false;
    render(<ConnectedStaking deployment={d} />);
    await screen.findByLabelText("TURRET to stake");
    fireEvent.click(screen.getByRole("button", { name: "Unstake" }));
    fireEvent.change(screen.getByLabelText("TURRET to withdraw"), { target: { value: "1" } });
    expect(screen.getByText("This amount exceeds your available TURRET.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Review withdrawal" })).toBeDisabled();
  });
  it("claims USDG independently of the stake", async () => {
    render(<ConnectedStaking deployment={d} />);
    await screen.findByLabelText("TURRET to stake");
    fireEvent.click(screen.getByRole("button", { name: "Review USDG claim" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm in wallet" }));
    await screen.findByText(/USDG claim confirmed\./);
    expect(f.provider.writeContract.mock.calls.map(([p]) => p.functionName)).toEqual(["claim"]);
  });
  it("retains a lost wallet response across remounts and blocks duplicate sending", async () => {
    f.provider.writeContract.mockRejectedValueOnce(Error("Wallet disconnected before returning a hash"));
    const view = render(<ConnectedStaking deployment={d} />);
    fireEvent.change(await screen.findByLabelText("TURRET to stake"), { target: { value: "1" } });
    fireEvent.click(screen.getByRole("button", { name: "Review stake" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm in wallet" }));
    await screen.findByRole("heading", { name: "Check your pending transaction" });
    view.unmount(); render(<ConnectedStaking deployment={d} />);
    expect(await screen.findByLabelText("Transaction hash from your wallet")).toBeVisible();
    await screen.findByLabelText("TURRET to stake");
    expect(screen.getByRole("button", { name: "Review stake" })).toBeDisabled();
    expect(f.provider.writeContract).toHaveBeenCalledTimes(1);
  });
  it("invalidates a review when the connected wallet changes", async () => {
    const view = render(<ConnectedStaking deployment={d} />);
    fireEvent.change(await screen.findByLabelText("TURRET to stake"), { target: { value: "1" } });
    fireEvent.click(screen.getByRole("button", { name: "Review stake" }));
    activeAccount = { chainId: 4663 }; view.rerender(<ConnectedStaking deployment={d} />);
    await waitFor(() => expect(screen.queryByRole("button", { name: "Confirm in wallet" })).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Connect wallet" })).toBeVisible();
  });
  it("shows a recoverable read error instead of a zero balance", async () => {
    f.rpc.getCode.mockRejectedValue(Error("RPC unavailable"));
    render(<ConnectedStaking deployment={d} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("RPC unavailable");
    expect(screen.queryByLabelText("TURRET to stake")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Refresh balances" })).toBeEnabled();
  });
});
