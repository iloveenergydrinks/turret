// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import type { IsolatedMarket } from "@/src/isolated-market-config";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import {
  type Address,
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionData,
  erc20Abi,
  parseAbiParameters,
} from "viem";
import { isolatedPoolAbi } from "@/src/isolated-credit";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  account: {
    address: "0x9999999999999999999999999999999999999999" as string | undefined,
    chainId: 4663,
  },
  read: vi.fn(),
  prepare: vi.fn(),
  quote: vi.fn(),
  send: vi.fn(),
  receipt: vi.fn(),
  transaction: vi.fn(),
  chain: vi.fn(),
  addresses: vi.fn(),
}));
vi.mock("@/src/isolated-credit", async (original) => ({
  ...(await original<object>()),
  readIsolatedMarket: mocks.read,
  prepareIsolatedAction: mocks.prepare,
  quoteLenderIntent: mocks.quote,
}));
vi.mock("@/src/isolated-market-config", () => ({
  getIsolatedMarket: () => undefined,
}));
vi.mock("@/src/deployment-config", () => ({ READ_ONLY_DEPLOYMENT: false }));
vi.mock("@/src/env", () => ({
  CHAIN_BLOCK_EXPLORER: { url: "https://explorer.example.test" },
}));
vi.mock("@/src/screens/DockyardBorrowScreen/BorrowerAlerts", () => ({
  BorrowerAlerts: ({ engine }: { engine: string }) => (
    <p>Alerts for {engine}</p>
  ),
}));
const client = {
  waitForTransactionReceipt: mocks.receipt,
  getTransaction: mocks.transaction,
};
const wallet = {
  getChainId: mocks.chain,
  getAddresses: mocks.addresses,
  sendTransaction: mocks.send,
};
vi.mock("wagmi", () => ({
  useAccount: () => mocks.account,
  usePublicClient: () => client,
  useWalletClient: () => ({ data: wallet }),
  useBalance: () => ({ data: { value: 10n ** 16n }, isPending: false, isError: false }),
}));
import {
  IsolatedMarketRoute,
  IsolatedMarketScreen,
} from "./IsolatedMarketScreen";
const addr = (x: string) => `0x${x.repeat(40)}` as Address;
const hash = `0x${"ab".repeat(32)}` as const;
const market: IsolatedMarket = {
  chainId: 4663,
  symbol: "CASHCAT",
  engine: addr("1"),
  pool: addr("2"),
  collateral: "0x020bfc650a365f8bb26819deaabf3e21291018b4",
  primary: addr("4"),
  secondary: addr("5"),
  hashes: {
    engine: hash,
    pool: hash,
    collateral: hash,
    primary: hash,
    secondary: hash,
    usdg: hash,
  },
};
const account = addr("9"),
  key = `dockyard:pending:4663:${market.engine}:${account}`;
const intent = {
  kind: "lend",
  amount: 1000000n,
  minShares: 995000000000n,
  deadline: BigInt(Math.floor(Date.now() / 1000) + 300),
};
const transactionStep = {
  kind: "transaction",
  account,
  chainId: 4663,
  to: market.pool,
  data: "0x1234",
  value: 0n,
  gas: 175000n,
  snapshotBlock: 10n,
  validUntil: BigInt(Math.floor(Date.now() / 1000) + 60),
  intent,
};
const snapshot = {
  collateral: 10n ** 18n,
  debt: 40000000n,
  price: 100n * 10n ** 18n,
  riskPaused: false,
  liquidationLtvBps: 6500,
  aprBps: 1000,
  feeBps: 1000,
  cash: 100000000n,
  shares: 100n * 10n ** 12n,
  totalAssets: 110000000n,
  totalShares: 100n * 10n ** 12n,
  maxWithdraw: 20000000n,
  maxBorrow: 10000000n,
  principal: 40000000n,
  minimumDebt: 1000000n,
  collateralBalance: 2n * 10n ** 18n,
  cashBalance: 200000000n,
};
const stockMarket: IsolatedMarket = {
  ...market,
  symbol: "AAPL",
  stock: {
    executionGate: addr("6"),
    usdgPrimary: addr("7"),
    usdgSecondary: addr("8"),
    riskMonitorUrl: "https://risk.example.test",
    hashes: { executionGate: hash, usdgPrimary: hash, usdgSecondary: hash },
  },
};
function stockPayload(counter = 0) {
  const now = BigInt(Math.floor(Date.now() / 1000)),
    validUntil = now + 40n;
  return {
    kind: "stock-pool",
    chainId: 4663,
    engine: market.engine,
    pool: market.pool,
    collateral: market.collateral,
    adapter: market.secondary,
    executionGate: addr("6"),
    usdgPrimary: addr("7"),
    usdgSecondary: addr("8"),
    validUntil: Number(validUntil),
    health: encodeAbiParameters(
      parseAbiParameters(
        "(uint80,uint64,uint64,uint64,uint64,bytes32,uint64),bytes,bytes",
      ),
      [
        [1n, now, validUntil, now - 120n, now + 3600n, hash, 0n],
        `0x${"11".repeat(65)}`,
        `0x${(counter % 2 ? "22" : "33").repeat(65)}`,
      ],
    ),
    liveness: encodeAbiParameters(
      parseAbiParameters("(uint64,uint64,uint64,uint64),bytes"),
      [[now, now - 120n, validUntil, 0n], "0x1234"],
    ),
  };
}
beforeEach(() => {
  const stored = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => stored.set(key, value),
    removeItem: (key: string) => stored.delete(key),
    clear: () => stored.clear(),
  });
  vi.resetAllMocks();
  mocks.account = { address: account, chainId: 4663 };
  mocks.read.mockResolvedValue(snapshot);
  mocks.quote.mockResolvedValue(intent);
  mocks.prepare.mockResolvedValue(transactionStep);
  mocks.chain.mockResolvedValue(4663);
  mocks.addresses.mockResolvedValue([account]);
  mocks.send.mockImplementation(async () => {
    expect(JSON.parse(localStorage.getItem(key) ?? "null")).toMatchObject({
      account,
      afterBlock: "10",
    });
    return hash;
  });
  mocks.receipt.mockResolvedValue({
    status: "success",
    transactionHash: hash,
    blockNumber: 12n,
  });
  mocks.transaction.mockResolvedValue({
    to: market.pool,
    input: "0x1234",
    from: account,
    value: 0n,
  });
});

test("commissioning blocks new funds before review, while preserving exit review", async () => {
  render(
    <IsolatedMarketScreen
      market={{ ...market, admission: "commissioning" }}
      mode="earn"
    />,
  );
  await screen.findByRole("heading", { name: "This market is not open yet" });
  await screen.findByText("100 USDG");
  fireEvent.change(screen.getByLabelText("Amount to lend · USDG"), {
    target: { value: "1" },
  });
  expect(
    screen.getByRole("button", { name: "Review lend usdg" }),
  ).toBeDisabled();
  fireEvent.submit(
    screen.getByRole("button", { name: "Review lend usdg" }).closest("form")!,
  );
  await screen.findByText(
    "This market is undergoing mainnet checks. New deposits and loans are not open yet.",
  );
  expect(mocks.prepare).not.toHaveBeenCalled();
  expect(mocks.send).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText("Action"), {
    target: { value: "withdraw" },
  });
  fireEvent.change(screen.getByLabelText("Amount to withdraw · USDG"), {
    target: { value: "1" },
  });
  expect(
    screen.getByRole("button", { name: "Review withdraw usdg" }),
  ).toBeEnabled();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
test("stock health service outage preserves debt and repayment review", async () => {
  const fetchMock = vi.fn(async () => new Response("{}", { status: 503 }));
  vi.stubGlobal("fetch", fetchMock);
  render(<IsolatedMarketScreen market={stockMarket} mode="borrow" />);
  await screen.findByRole("heading", {
    name: "New borrowing is temporarily unavailable",
  });
  expect(screen.getByText("40 USDG")).toBeVisible();
  const before = fetchMock.mock.calls.length;
  fireEvent.click(screen.getByRole("button", { name: "Repay USDG" }));
  fireEvent.change(screen.getByLabelText("Amount to repay · USDG"), {
    target: { value: "1" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Review repay usdg" }));
  await screen.findByRole("heading", { name: "Review transaction" });
  expect(fetchMock).toHaveBeenCalledTimes(before);
  expect(mocks.prepare.mock.calls.at(-1)?.[5]).toBeUndefined();
});
test("a closed stock market names the restriction, reopening time and protective actions", async () => {
  vi.stubGlobal("fetch",vi.fn(async()=>new Response(JSON.stringify({
    error:"Borrowing temporarily unavailable",code:"market_closed",reopensAt:Math.floor(Date.now()/1000)+3600,
  }),{status:503})));
  render(<IsolatedMarketScreen market={stockMarket} mode="borrow" />);
  await screen.findByRole("heading",{name:"New loans are closed with the U.S. market"});
  expect(screen.getByText(/Borrowing reopens/)).toBeVisible();
  expect(screen.getByText(/Repaying USDG and adding collateral remain available/)).toBeVisible();
});
test("a closed stock market offers a real collateral deposit path", async () => {
  mocks.read.mockResolvedValue({
    ...snapshot,
    collateral: 0n,
    debt: 0n,
    collateralBalance: 2n * 10n ** 18n,
    minimumDebt: 1_000_000n,
  });
  const fetchMock = vi.fn(async()=>new Response(JSON.stringify({
    error:"Borrowing temporarily unavailable",code:"market_closed",reopensAt:Math.floor(Date.now()/1000)+3600,
  }),{status:503}));
  vi.stubGlobal("fetch", fetchMock);
  render(<IsolatedMarketScreen market={stockMarket} mode="borrow" />);
  await screen.findByRole("heading",{name:"New loans are closed with the U.S. market"});
  fireEvent.click(screen.getByRole("button", {name:"Deposit AAPL collateral now"}));
  expect(screen.getByText(/locks AAPL in the collateral contract without borrowing USDG/)).toBeVisible();
  fireEvent.change(screen.getByLabelText("Collateral to add · AAPL"), {
    target: {value:"1"},
  });
  fireEvent.click(screen.getByRole("button", {name:"Review add collateral"}));
  await screen.findByRole("heading", {name:"Review transaction"});
  expect(mocks.prepare.mock.calls.at(-1)?.[3]).toEqual({kind:"addCollateral",amount:10n**18n});
  expect(fetchMock).toHaveBeenCalledTimes(1);
});
test("a collateral-only position gets a clear first-loan action", async () => {
  mocks.read.mockResolvedValue({...snapshot, debt:0n, principal:0n});
  render(<IsolatedMarketScreen market={market} mode="borrow" />);
  expect(await screen.findByRole("radio", {
    name:"Use deposited collateral",
  })).toBeVisible();
});
test("market closure is visible before wallet connection", async () => {
  mocks.account = {address:undefined,chainId:4663};
  vi.stubGlobal("fetch",vi.fn(async()=>new Response(JSON.stringify({
    error:"Borrowing temporarily unavailable",code:"market_closed",reopensAt:Math.floor(Date.now()/1000)+3600,
  }),{status:503})));
  render(<IsolatedMarketScreen market={stockMarket} mode="borrow" />);
  await screen.findByRole("heading",{name:"New loans are closed with the U.S. market"});
  expect(screen.getByText(/Borrowing reopens/)).toBeVisible();
});
test("stock proof refresh can be confirmed once without changing reviewed lender limits", async () => {
  let count = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(stockPayload(count++)))),
  );
  mocks.prepare.mockImplementation(
    async (_c, _m, _w, intent, _clock, proofs) => ({
      ...transactionStep,
      intent,
      data: encodeFunctionData({
        abi: isolatedPoolAbi,
        functionName: "depositChecked",
        args: [
          intent.amount,
          account,
          intent.minShares,
          intent.deadline,
          proofs.health,
          proofs.liveness,
        ],
      }),
    }),
  );
  mocks.transaction.mockImplementation(async () => ({
    to: market.pool,
    input: mocks.send.mock.calls.at(-1)?.[0].data,
    from: account,
    value: 0n,
  }));
  render(<IsolatedMarketScreen market={stockMarket} mode="earn" />);
  await screen.findByText("100 USDG");
  fireEvent.change(screen.getByLabelText("Amount to lend · USDG"), {
    target: { value: "1" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Review lend usdg" }));
  await screen.findByRole("heading", { name: "Review transaction" });
  fireEvent.click(screen.getByRole("button", { name: "Confirm in wallet" }));
  await waitFor(() => expect(mocks.send).toHaveBeenCalledTimes(1));
  await screen.findByText(/Transaction confirmed/);
  const sent = decodeFunctionData({
    abi: isolatedPoolAbi,
    data: mocks.send.mock.calls[0]![0].data,
  });
  expect(sent).toMatchObject({
    functionName: "depositChecked",
    args: [
      intent.amount,
      account,
      intent.minShares,
      intent.deadline,
      expect.any(String),
      expect.any(String),
    ],
  });
  expect(mocks.prepare.mock.calls[0]![5]).not.toEqual(
    mocks.prepare.mock.calls[1]![5],
  );
  expect(localStorage.getItem(key)).toBeNull();
});
async function openReview() {
  render(<IsolatedMarketScreen market={market} mode="earn" />);
  await screen.findByText("100 USDG");
  fireEvent.change(screen.getByLabelText("Amount to lend · USDG"), {
    target: { value: "1" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Review lend usdg" }));
  await screen.findByRole("heading", { name: "Review transaction" });
}
test("unconfigured engine has no controls or wallet reads", () => {
  render(<IsolatedMarketRoute engine="unknown" mode="borrow" />);
  expect(screen.getByText(/not configured/)).toBeVisible();
  expect(mocks.read).not.toHaveBeenCalled();
});
test("disconnected and wrong-network users cannot submit", () => {
  for (const address of [undefined, account]) {
    mocks.account = { address, chainId: 1 };
    const view = render(<IsolatedMarketScreen market={market} mode="borrow" />);
    expect(
      screen.getByRole("button", { name: /Review deposit/ }),
    ).toBeDisabled();
    view.unmount();
  }
  expect(mocks.read).toHaveBeenCalledTimes(1);
  expect(mocks.send).not.toHaveBeenCalled();
});
test("disconnected lenders can inspect public pool terms without seeing a personal position", async () => {
  mocks.account = { address: undefined, chainId: 1 };
  render(<IsolatedMarketScreen market={market} mode="earn" />);
  await screen.findByRole("heading", { name: "CASHCAT pool right now" });
  expect(screen.getByText("36.36%")).toBeVisible();
  expect(screen.getByText("3.27%")).toBeVisible();
  expect(
    screen.queryByRole("heading", { name: "Your position in this pool" }),
  ).not.toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Review lend usdg" }),
  ).toBeDisabled();
});
test("lender cash availability is distinct from claim value, and review never submits", async () => {
  await openReview();
  expect(
    screen.getByRole("navigation", { name: "CASHCAT market" }),
  ).toBeVisible();
  expect(
    screen.getByRole("link", { name: /Lend USDG to this pool/ }),
  ).toHaveAttribute("aria-current", "page");
  expect(within(screen.getByRole("region", { name: "Withdrawal availability" })).getByText("20 USDG")).toBeVisible();
  expect(screen.getByText("36.36%")).toBeVisible();
  expect(screen.getByText("3.27%")).toBeVisible();
  fireEvent.click(screen.getByText("How your return is calculated"));
  expect(screen.getByText(/Borrower APR is not lender APY/)).toBeVisible();
  expect(screen.getByText(/Minimum shares received: 0.995/)).toBeVisible();
  expect(mocks.send).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Confirm in wallet" }));
  await screen.findByText(/Transaction confirmed/);
  expect(mocks.send).toHaveBeenCalledTimes(1);
  expect(mocks.send.mock.calls[0]![0]).toMatchObject({
    to: market.pool,
    data: "0x1234",
    value: 0n,
    gas: 175000n,
  });
  expect(localStorage.getItem(key)).toBeNull();
});
test("available exit fills a partial withdrawal without preparing or sending a transaction", async () => {
  render(<IsolatedMarketScreen market={market} mode="earn" />);
  const fill = await screen.findByRole("button", { name: "Use available amount" });
  fireEvent.click(fill);
  expect(screen.getByRole("combobox", { name: "Action" })).toHaveValue("withdraw");
  expect(screen.getByRole("textbox", { name: "Amount to withdraw · USDG" })).toHaveValue("20");
  expect(screen.getByText("No additional wallet tokens are needed for this action.")).toBeVisible();
  expect(mocks.quote).not.toHaveBeenCalled();
  expect(mocks.prepare).not.toHaveBeenCalled();
  expect(mocks.send).not.toHaveBeenCalled();
});

test("failed withdrawal refresh removes the old executable amount", async () => {
  render(<IsolatedMarketScreen market={market} mode="earn" />);
  await screen.findByRole("button", { name: "Use available amount" });
  mocks.read.mockRejectedValueOnce(new Error("RPC unavailable"));
  fireEvent.click(screen.getByText("How withdrawals work"));
  fireEvent.click(screen.getByRole("button", { name: "Refresh availability" }));
  await screen.findByText("Withdrawal data is unavailable. Refresh to try again.");
  expect(screen.queryByRole("button", { name: "Use available amount" })).not.toBeInTheDocument();
  expect(mocks.send).not.toHaveBeenCalled();
});

test("funding checklist follows collateral and repayment amounts", async () => {
  render(<IsolatedMarketScreen market={market} mode="borrow" />);
  await screen.findByText("2 CASHCAT in wallet.");
  fireEvent.change(screen.getByLabelText("Collateral to deposit · CASHCAT"), { target: { value: "3" } });
  expect(screen.getByText("Add enough to cover the entered amount.")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Repay USDG" }));
  expect(screen.getByText("200 USDG in wallet.")).toBeVisible();
  fireEvent.change(screen.getByLabelText("Amount to repay · USDG"), { target: { value: "20" } });
  expect(screen.getByText("Covers the entered amount.")).toBeVisible();
  expect(mocks.send).not.toHaveBeenCalled();
});

test("approval and lending need separate confirmations with the same reviewed limits", async () => {
  const approval = {
    ...transactionStep,
    kind: "approval",
    to: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
    data: encodeFunctionData({
      abi: erc20Abi,
      functionName: "approve",
      args: [market.pool, 1000000n],
    }),
  };
  mocks.prepare
    .mockResolvedValueOnce(approval)
    .mockResolvedValueOnce(approval)
    .mockResolvedValue(transactionStep);
  mocks.transaction.mockResolvedValueOnce({
    to: approval.to,
    input: approval.data,
    from: account,
    value: 0n,
  });
  render(<IsolatedMarketScreen market={market} mode="earn" />);
  await screen.findByText("100 USDG");
  fireEvent.change(screen.getByLabelText("Amount to lend · USDG"), {
    target: { value: "1" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Review lend usdg" }));
  await screen.findByRole("heading", { name: "Review token approval" });
  fireEvent.click(screen.getByRole("button", { name: "Confirm in wallet" }));
  await screen.findByRole("heading", { name: "Review transaction" });
  expect(mocks.send).toHaveBeenCalledTimes(1);
  expect(mocks.prepare.mock.calls[2]![3]).toEqual(intent);
  expect(mocks.quote).toHaveBeenCalledTimes(1);
});
test("a receipt timeout survives remount and blocks duplicate sends until confirmed", async () => {
  mocks.receipt.mockRejectedValueOnce(new Error("timeout"));
  await openReview();
  fireEvent.click(screen.getByRole("button", { name: "Confirm in wallet" }));
  await screen.findByRole("button", { name: "Check transaction confirmation" });
  expect(localStorage.getItem(key)).toContain(hash);
  cleanup();
  render(<IsolatedMarketScreen market={market} mode="earn" />);
  await screen.findByText(/submitted transaction needs confirmation/);
  expect(
    screen.getByRole("button", { name: "Review lend usdg" }),
  ).toBeDisabled();
  fireEvent.click(
    screen.getByRole("button", { name: "Check transaction confirmation" }),
  );
  await screen.findByText(/Transaction confirmed/);
  expect(mocks.send).toHaveBeenCalledTimes(1);
  expect(localStorage.getItem(key)).toBeNull();
});
test("rejected wallet requests clear the journal, but ambiguous errors do not", async () => {
  for (const error of [
    { code: 4001 },
    { cause: { code: 4001 } },
    new Error("provider disconnected"),
  ]) {
    mocks.send.mockRejectedValue(error);
    await openReview();
    fireEvent.click(screen.getByRole("button", { name: "Confirm in wallet" }));
    await screen.findByRole("alert");
    if ("code" in error || "cause" in error)
      expect(localStorage.getItem(key)).toBeNull();
    else {
      expect(localStorage.getItem(key)).toContain("afterBlock");
      expect(
        screen.getByLabelText("Transaction hash from your wallet"),
      ).toBeVisible();
    }
    cleanup();
  }
});
test("unavailable recovery storage prevents opening the wallet", async () => {
  await openReview();
  vi.spyOn(localStorage, "setItem").mockImplementation(() => {
    throw new Error("disabled");
  });
  fireEvent.click(screen.getByRole("button", { name: "Confirm in wallet" }));
  await screen.findByText(/recovery storage is unavailable/);
  expect(mocks.send).not.toHaveBeenCalled();
});
test("late preparation after wallet switch cannot open the old wallet request", async () => {
  await openReview();
  let resolve!: (v: typeof transactionStep) => void;
  mocks.prepare.mockImplementationOnce(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Confirm in wallet" }));
  await waitFor(() => expect(mocks.prepare).toHaveBeenCalledTimes(2));
  cleanup();
  mocks.account = { address: addr("8"), chainId: 4663 };
  render(<IsolatedMarketScreen market={market} mode="earn" />);
  await act(async () => resolve(transactionStep));
  expect(mocks.send).not.toHaveBeenCalled();
});
test("recovery refuses another wallet, an old transaction, and unrelated calldata", async () => {
  for (const tx of [{ from: addr("8") }, { input: "0xffff" }, { old: true }]) {
    localStorage.setItem(
      key,
      JSON.stringify({
        to: market.pool,
        data: "0x1234",
        account,
        kind: "transaction",
        afterBlock: "10",
      }),
    );
    mocks.transaction.mockResolvedValue({
      to: market.pool,
      input: "0x1234",
      from: account,
      value: 0n,
      ...tx,
    });
    mocks.receipt.mockResolvedValue({
      status: "success",
      transactionHash: hash,
      blockNumber: "old" in tx ? 9n : 12n,
    });
    render(<IsolatedMarketScreen market={market} mode="earn" />);
    fireEvent.change(
      await screen.findByLabelText("Transaction hash from your wallet"),
      { target: { value: hash } },
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Check transaction confirmation" }),
    );
    await screen.findByText(/pending request remains locked/);
    expect(localStorage.getItem(key)).not.toBeNull();
    cleanup();
  }
});
test("oracle outage leaves protective actions visible without inventing prices", async () => {
  mocks.read.mockResolvedValue({ ...snapshot, price: null, riskPaused: true });
  render(<IsolatedMarketScreen market={market} mode="borrow" />);
  await screen.findByRole("heading", {
    name: "New borrowing is temporarily unavailable",
  });
  expect(screen.getByText(/Risk data unavailable/)).toBeVisible();
  expect(
    screen.getByRole("button", { name: "Repay USDG" }),
  ).toBeInTheDocument();
  expect(
    within(screen.getByRole("group", { name: "Loan actions" })).getByRole("button", { name: "Collateral" }),
  ).toBeInTheDocument();
});

test("confirmed cancellation replacements are not reported as successful actions", async () => {
  const replacementHash = `0x${"cd".repeat(32)}`;
  mocks.receipt.mockImplementation(async ({ onReplaced }) => {
    const receipt = {
      status: "success",
      transactionHash: replacementHash,
      blockNumber: 12n,
    };
    onReplaced({ transactionReceipt: receipt });
    return receipt;
  });
  mocks.transaction.mockResolvedValue({
    to: account,
    input: "0x",
    from: account,
    value: 0n,
  });
  await openReview();
  fireEvent.click(screen.getByRole("button", { name: "Confirm in wallet" }));
  await screen.findByText(/action reverted or was replaced/);
  expect(screen.queryByText(/Transaction confirmed/)).not.toBeInTheDocument();
  expect(localStorage.getItem(key)).toBeNull();
  expect(screen.getByRole("link", { name: replacementHash })).toHaveAttribute(
    "href",
    `https://explorer.example.test/tx/${replacementHash}`,
  );
});

test("a corrupted journal stays locked and never prompts the wallet", async () => {
  localStorage.setItem(key, "bad json");
  render(<IsolatedMarketScreen market={market} mode="earn" />);
  await screen.findByText(/pending transaction record could not be verified/);
  expect(
    screen.getByRole("button", { name: "Review lend usdg" }),
  ).toBeDisabled();
  expect(mocks.send).not.toHaveBeenCalled();
});

test("overlapping outages have one availability notice and preserve repayment", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("{}", { status: 503 })),
  );
  mocks.read.mockResolvedValue({ ...snapshot, price: null, riskPaused: true });
  render(
    <IsolatedMarketScreen
      market={{ ...stockMarket, admission: "commissioning" }}
      mode="borrow"
    />,
  );
  await screen.findByText("40 USDG");
  expect(
    screen.getAllByRole("status", { name: "Market availability" }),
  ).toHaveLength(1);
  expect(
    screen.getByRole("heading", { name: "This market is not open yet" }),
  ).toBeVisible();
  expect(
    screen.queryByText(/Stock health checks|Oracle price unavailable/),
  ).not.toBeInTheDocument();
  expect(
    within(screen.getByRole("status", { name: "Loan health" })).queryByRole("button", { name: "Add collateral" }),
  ).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Repay loan" }));
  expect(screen.getByLabelText("Amount to repay · USDG")).toHaveFocus();
  fireEvent.change(screen.getByLabelText("Amount to repay · USDG"), {
    target: { value: "1" },
  });
  expect(
    screen.getByRole("button", { name: "Review repay usdg" }),
  ).toBeEnabled();
  expect(mocks.send).not.toHaveBeenCalled();
});

test("read failure clears balances and its notice disappears after successful refresh", async () => {
  mocks.read.mockRejectedValueOnce(new Error("RPC unavailable"));
  render(<IsolatedMarketScreen market={market} mode="borrow" />);
  await screen.findByRole("heading", {
    name: "We couldn’t load your balances",
  });
  expect(screen.queryByText("40 USDG")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: /Review deposit/ })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Refresh balances" }));
  await screen.findByText("40 USDG");
  expect(
    screen.queryByRole("status", { name: "Market availability" }),
  ).not.toBeInTheDocument();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

test("loan risk remains prominent during a market outage and no-debt users get no urgency", async () => {
  mocks.read.mockResolvedValue({
    ...snapshot,
    debt: 64000000n,
    riskPaused: true,
  });
  const view = render(<IsolatedMarketScreen market={market} mode="borrow" />);
  await screen.findByRole("heading", {
    name: "Critically close to liquidation",
  });
  expect(screen.getByRole("alert", { name: "Loan health" })).toBeVisible();
  expect(
    screen.getByRole("status", { name: "Market availability" }),
  ).toBeVisible();
  view.unmount();
  mocks.read.mockResolvedValue({
    ...snapshot,
    debt: 0n,
    collateral: 0n,
    price: null,
  });
  render(<IsolatedMarketScreen market={market} mode="borrow" />);
  await screen.findByRole("heading", { name: "No outstanding loan" });
  expect(screen.queryByText(/Price gaps/)).not.toBeInTheDocument();
  expect(
    screen.queryByRole("alert", { name: "Loan health" }),
  ).not.toBeInTheDocument();
});

test("existing loan actions explain their effect and clear amounts when switching", async () => {
  render(<IsolatedMarketScreen market={market} mode="borrow" />);
  await screen.findByRole("heading", { name: "Manage your existing loan" });
  expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
  expect(screen.getByText(/This does not open a separate loan/)).toBeVisible();
  fireEvent.change(screen.getByLabelText("Amount to borrow · USDG"), { target: { value: "5" } });
  const repay = screen.getByRole("button", { name: "Repay USDG" });
  fireEvent.click(repay);
  expect(repay).toHaveAttribute("aria-pressed", "true");
  expect(screen.getByLabelText("Amount to repay · USDG")).toHaveValue("");
  expect(screen.queryByLabelText("Collateral to deposit · AAPL")).not.toBeInTheDocument();
});

test("compact loan navigation exposes collateral and full repayment without a dropdown", async () => {
  render(<IsolatedMarketScreen market={market} mode="borrow" />);
  await screen.findByRole("heading", { name: "Manage your existing loan" });
  fireEvent.click(screen.getByRole("button", { name: "Collateral" }));
  fireEvent.click(screen.getByRole("radio", { name: "Withdraw collateral" }));
  expect(screen.getByLabelText("Collateral to withdraw · CASHCAT")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Repay USDG" }));
  fireEvent.click(screen.getByRole("radio", { name: "Repay all & close" }));
  expect(screen.getByLabelText("Maximum repayment · USDG")).toBeVisible();
  expect(screen.getByText(/return all deposited CASHCAT to your wallet/)).toBeVisible();
});
