"use client";
import {swapCollateralPrefill} from "../../borrow/swap-prefill";
import { TermLabel } from "../../comps/FieldInfo/FieldInfo";

import { rewardsForPool } from "../../lending/rewards/client";
import { RewardsPanel } from "../../lending/rewards/RewardsPanel";
// Extends Turret's existing narrow borrowing workspace: one task form, one
// position ledger, explicit risk states and a separate wallet review step.
import { READ_ONLY_DEPLOYMENT } from "@/src/deployment-config";
import { positiveAmount } from "@/src/dockyard-amount";
import { CHAIN_BLOCK_EXPLORER } from "@/src/env";
import {
  ISOLATED_USDG,
  isolatedPoolAbi,
  IsolatedCreditError,
  type IsolatedIntent,
  type IsolatedMarketState,
  prepareIsolatedAction,
  quoteLenderIntent,
} from "@/src/isolated-credit";
import {
  getIsolatedMarket,
  type IsolatedMarket,
} from "@/src/isolated-market-config";
import {
  readStockWorkspace,
  sameReviewedAction,
  stockProofsForAction,
  type StockProofIssue,
} from "@/src/isolated-stock-proofs";
import { BorrowerAlerts } from "@/src/screens/DockyardBorrowScreen/BorrowerAlerts";
import { WalletReadiness } from "@/src/onboarding/WalletReadiness";
import { LenderExitStatus } from "@/src/lending/LenderExitStatus";
import { useCallback, useEffect, useRef, useState } from "react";
import { decodeFunctionData, erc20Abi, formatUnits, type Hex } from "viem";
import { useAccount, usePublicClient, useWalletClient } from "wagmi";

import { actionExplanation } from "./actionExplanation";

type Mode = "borrow" | "earn";
type Step = Awaited<ReturnType<typeof prepareIsolatedAction>>;
type Pending = Pick<Step, "to" | "data" | "account" | "kind"> & {
  hash?: Hex;
  afterBlock: string;
};
const labels: Record<IsolatedIntent["kind"], string> = {
  depositBorrow: "Deposit & borrow",
  borrow: "Borrow more",
  addCollateral: "Add collateral",
  removeCollateral: "Withdraw collateral",
  repay: "Repay USDG",
  close: "Repay & close",
  lend: "Lend USDG",
  withdraw: "Withdraw USDG",
  redeem: "Redeem shares",
  redeemWorthless: "Surrender worthless shares",
};
const amountLabels: Record<IsolatedIntent["kind"], string> = {
  depositBorrow: "Amount to borrow",
  borrow: "Amount to borrow",
  addCollateral: "Collateral to add",
  removeCollateral: "Collateral to withdraw",
  repay: "Amount to repay",
  close: "Maximum repayment",
  lend: "Amount to lend",
  withdraw: "Amount to withdraw",
  redeem: "Shares to redeem",
  redeemWorthless: "Shares to surrender",
};
const units = (value: bigint | undefined, decimals = 6) =>
  value === undefined ? "—" : formatUnits(value, decimals);
const READ_ONLY_WALLET = "0x000000000000000000000000000000000000dEaD" as const;
const percentage = (bps: bigint) =>
  `${bps / 100n}.${(bps % 100n).toString().padStart(2, "0")}%`;
function walletRejected(error: unknown): boolean {
  let current = error;
  for (
    let depth = 0;
    depth < 8 && current && typeof current === "object";
    depth++
  ) {
    if ((current as { code?: number }).code === 4001) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}
const errorText = (e: unknown) =>
  e instanceof IsolatedCreditError
    ? e.message
    : walletRejected(e)
      ? "Cancelled in your wallet. No new transaction was submitted."
      : "The request could not be completed. Check your wallet and connection, then retry.";

function reopeningText(reopensAt?: number): string {
  if (!reopensAt) return "during the next supported U.S. trading session";
  return new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(new Date(reopensAt * 1000));
}

export function IsolatedMarketRoute({
  engine,
  mode,
}: {
  engine: string;
  mode: Mode;
}) {
  const market = getIsolatedMarket(engine);
  if (!market || READ_ONLY_DEPLOYMENT) {
    return (
      <main className="dockyard-borrow">
        <section className="dockyard-alert-settings dockyard-alert-verification">
          <h1>Isolated market unavailable</h1>
          <p>
            This market is not configured for transactions on Turret. No
            transaction can be submitted from this page.
          </p>
          <a className="dockyard-alert-link" href="/">
            Back to Turret
          </a>
        </section>
      </main>
    );
  }
  return <IsolatedMarketScreen market={market} mode={mode} />;
}
export function IsolatedMarketScreen({
  market,
  mode,
}: {
  market: IsolatedMarket;
  mode: Mode;
}) {
  const { address, chainId } = useAccount();
  return (
    <Workspace
      key={`${market.engine}:${address ?? "disconnected"}:${chainId}:${mode}`}
      market={market}
      mode={mode}
    />
  );
}
function Workspace({ market, mode }: { market: IsolatedMarket; mode: Mode }) {
  const { address, chainId } = useAccount();
  const client = usePublicClient({ chainId: 4663 });
  const { data: wallet, refetch: refreshWalletClient } = useWalletClient();
  const [state, setState] = useState<IsolatedMarketState | null>(null);
  const [action, setAction] = useState<IsolatedIntent["kind"]>(
    mode === "earn" ? "lend" : "depositBorrow",
  );
  const [input, setInput] = useState("");
  const [extra, setExtra] = useState("");
  const swapPrefilled = useRef(false);
  useEffect(() => {
    if (swapPrefilled.current || !state || !address || mode !== "borrow") return;
    swapPrefilled.current = true;
    const prefill = swapCollateralPrefill(new URLSearchParams(window.location.search), address, state.collateralBalance);
    if (prefill !== null) setExtra(prefill);
  }, [state, address, mode]);
  const [step, setStep] = useState<Step | null>(null);
  const [busy, setBusy] = useState(false);
  const [rewardsBusy, setRewardsBusy] = useState(false);
  const [depositReceipt, setDepositReceipt] = useState<{hash: Hex; block: bigint}>();
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [proofUnavailable, setProofUnavailable] = useState(false);
  const [proofIssue, setProofIssue] = useState<StockProofIssue | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [hash, setHash] = useState<Hex>();
  const [uncertain, setUncertain] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);
  const [recoveryHash, setRecoveryHash] = useState("");
  const active = useRef(true),
    locked = useRef(false),
    polling = useRef(false);
  const amountField = useRef<HTMLInputElement>(null);
  const reviewHeading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (step) reviewHeading.current?.focus();
  }, [step]);
  const journalKey = `dockyard:pending:4663:${market.engine.toLowerCase()}:${address?.toLowerCase()}`;
  function remember(value: Pending | null) {
    try {
      if (value) localStorage.setItem(journalKey, JSON.stringify(value));
      else localStorage.removeItem(journalKey);
    } catch {
      throw new IsolatedCreditError(
        "Transaction recovery storage is unavailable. Enable site storage before using this market.",
      );
    }
  }
  const wrongChain = Boolean(address && chainId !== 4663);
  const collateralLabel = market.stock ? `${market.symbol} Stock Tokens` : market.symbol;
  const admissionBlocked = (kind: IsolatedIntent["kind"]) =>
    market.admission === "commissioning" &&
    ["lend", "depositBorrow", "borrow", "addCollateral"].includes(kind);
  function checkAdmission(kind: IsolatedIntent["kind"]) {
    if (admissionBlocked(kind)) {
      throw new IsolatedCreditError(
        "This market is undergoing mainnet checks. New deposits and loans are not open yet.",
      );
    }
  }
  const refresh = useCallback(async () => {
    if (
      !client ||
      wrongChain ||
      polling.current
    )
      return;
    polling.current = true;
    setRefreshing(true);
    try {
      const snapshot = await readStockWorkspace(
        client,
        market,
        address ?? READ_ONLY_WALLET,
      );
      if (active.current) {
        setState(snapshot.state);
        setProofUnavailable(snapshot.proofUnavailable);
        setProofIssue(snapshot.proofIssue ?? null);
        setLoadFailed(false);
      }
    } catch {
      if (active.current) {
        setState(null);
        setProofIssue(null);
        setLoadFailed(true);
      }
    } finally {
      polling.current = false;
      if (active.current) setRefreshing(false);
    }
  }, [address, client, market, wrongChain]);
  useEffect(() => {
    active.current = true;
    function recover() {
      try {
        const raw = localStorage.getItem(journalKey);
        if (raw) {
          const value = JSON.parse(raw) as Pending;
          setUncertain(true);
          if (
            !/^\d{1,20}$/.test(value.afterBlock) ||
            (value.hash !== undefined &&
              !/^0x[\da-f]{64}$/i.test(value.hash)) ||
            !/^0x(?:[\da-f]{2})+$/i.test(value.data) ||
            value.data.length > 16384 ||
            value.account?.toLowerCase() !== address?.toLowerCase() ||
            ![
              market.engine,
              market.pool,
              market.collateral,
              ISOLATED_USDG,
            ].some((a) => a.toLowerCase() === value.to?.toLowerCase()) ||
            !["approval", "transaction"].includes(value.kind)
          )
            throw new Error("Invalid pending record");
          setPending(value);
          setHash(value.hash);
          setStep(null);
          setMessage(
            value.hash
              ? "A submitted transaction needs confirmation before another action."
              : "A wallet request has an unknown outcome. Check your wallet activity and enter its transaction hash to verify it.",
          );
        } else if (!locked.current) {
          setPending(null);
          setUncertain(false);
        }
      } catch {
        setUncertain(true);
        setError(
          "A pending transaction record could not be verified. Check your wallet before continuing.",
        );
      }
    }
    recover();
    const onStorage = (event: StorageEvent) => {
      if (event.key === journalKey) recover();
    };
    window.addEventListener("storage", onStorage);
    window.addEventListener("focus", recover);
    void refresh();
    const timer = setInterval(() => void refresh(), 15000);
    return () => {
      active.current = false;
      clearInterval(timer);
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("focus", recover);
    };
  }, [address, journalKey, market.collateral, market.engine, market.pool, refresh]);
  const collateralAction =
    action === "addCollateral" || action === "removeCollateral";
  const shareAction = action === "redeem" || action === "redeemWorthless";
  const decimals = collateralAction ? 18 : shareAction ? 12 : 6;
  const unit = collateralAction
    ? market.symbol
    : shareAction
      ? "shares"
      : "USDG";
  async function task(fn: () => Promise<void>) {
    if (locked.current || rewardsBusy) return;
    locked.current = true;
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      if (active.current) setError(errorText(e));
    } finally {
      locked.current = false;
      if (active.current) setBusy(false);
    }
  }
  async function review(existing?: IsolatedIntent) {
    if (!client || !address || wrongChain) return;
    checkAdmission(existing?.kind ?? action);
    if (localStorage.getItem(journalKey)) {
      throw new IsolatedCreditError(
        "Resolve the pending wallet request before reviewing another action.",
      );
    }
    const amount = positiveAmount(input, decimals);
    const proofs = await stockProofsForAction(
      client,
      market,
      address,
      existing?.kind ?? action,
    );
    const intent =
      existing ??
      (action === "lend" || action === "withdraw" || action === "redeem"
        ? await quoteLenderIntent(
            client,
            market,
            address,
            action,
            amount,
            50,
            Date.now,
            proofs,
          )
        : action === "depositBorrow"
          ? {
              kind: action,
              amount,
              collateralAmount: positiveAmount(extra, 18),
            }
          : { kind: action, amount });
    const prepared = await prepareIsolatedAction(
      client,
      market,
      address,
      intent,
      Date.now,
      proofs,
    );
    if (active.current) {
      setStep(prepared);
      setMessage("");
    }
  }
  async function confirm() {
    if (!step || !client || !address || wrongChain) return;
    const connectedWallet = wallet ?? (await refreshWalletClient()).data;
    if (!active.current) return;
    if (!connectedWallet) throw new IsolatedCreditError("Could not connect to your wallet. Unlock MetaMask and try again, or reconnect using the wallet menu.");
    checkAdmission(step.intent.kind);
    if (BigInt(Math.floor(Date.now() / 1000)) >= step.validUntil) {
      throw new IsolatedCreditError(
        "This review expired. Review the action again.",
      );
    }
    const proofs = await stockProofsForAction(
      client,
      market,
      address,
      step.intent.kind,
    );
    const fresh = await prepareIsolatedAction(
      client,
      market,
      address,
      step.intent,
      Date.now,
      proofs,
    );
    if (!active.current) return;
    if (!sameReviewedAction(step, fresh)) {
      setStep(fresh);
      throw new IsolatedCreditError(
        "The required wallet step changed. Review it before confirming.",
      );
    }
    const [walletChain, addresses] = await Promise.all([
      connectedWallet.getChainId(),
      connectedWallet.getAddresses(),
    ]);
    if (!active.current) return;
    if (
      walletChain !== 4663 ||
      !addresses.some((a) => a.toLowerCase() === address.toLowerCase())
    ) {
      throw new IsolatedCreditError(
        "Your wallet or network changed. Reconnect and review again.",
      );
    }
    if (BigInt(Math.floor(Date.now() / 1000)) >= fresh.validUntil) {
      throw new IsolatedCreditError(
        "This review expired. Review the action again.",
      );
    }
    if (localStorage.getItem(journalKey)) {
      throw new IsolatedCreditError(
        "Another wallet request is pending. Resolve it before continuing.",
      );
    }
    // Persist BEFORE opening the wallet: reloads and ambiguous provider errors must
    // not erase a request that may have been broadcast. Store public metadata only.
    const signing: Pending = {
      to: fresh.to,
      data: fresh.data,
      account: fresh.account,
      kind: fresh.kind,
      afterBlock: fresh.snapshotBlock.toString(),
    };
    remember(signing);
    setPending(signing);
    setUncertain(true);
    let sent: Hex;
    try {
      sent = await connectedWallet.sendTransaction({
        account: address,
        chain: connectedWallet.chain,
        to: fresh.to,
        data: fresh.data,
        value: 0n,
        gas: fresh.gas,
      });
    } catch (e) {
      if (walletRejected(e)) {
        remember(null);
        if (active.current) {
          setPending(null);
          setUncertain(false);
        }
      } else if (active.current) {
        setStep(null);
        setMessage(
          "The wallet request has an unknown outcome. Check wallet activity before retrying.",
        );
      }
      throw e;
    }
    const submitted: Pending = { ...signing, hash: sent };
    if (active.current) {
      setPending(submitted);
      setHash(sent);
      setStep(null);
      setUncertain(true);
      setMessage("Transaction submitted. Waiting for confirmation…");
    }
    remember(submitted);
    if (!active.current) return;
    await settle(submitted, step.intent);
  }
  async function settle(
    submitted: Pending,
    intent?: IsolatedIntent,
    recoveringUnknown = false,
  ) {
    if (!client || !address) return;
    if (!submitted.hash)
      throw new IsolatedCreditError(
        "Enter the transaction hash from your wallet activity first.",
      );
    let resolved = false;
    try {
      const receipt = await client.waitForTransactionReceipt({
        hash: submitted.hash,
        confirmations: 2,
        timeout: 120000,
        onReplaced: (replacement) => {
          const replaced = {
            ...submitted,
            hash: replacement.transactionReceipt.transactionHash,
          };
          remember(replaced);
          if (active.current) {
            setHash(replaced.hash);
            setPending(replaced);
          }
        },
      });
      if (!active.current) return;
      // A cancelled/replaced transaction must not be mistaken for the reviewed call.
      const transaction = await client.getTransaction({
        hash: receipt.transactionHash,
      });
      if (receipt.blockNumber <= BigInt(submitted.afterBlock)) {
        throw new IsolatedCreditError(
          "This transaction predates the reviewed action. The pending request remains locked.",
        );
      }
      if (transaction.from.toLowerCase() !== submitted.account.toLowerCase()) {
        throw new IsolatedCreditError(
          "This transaction belongs to a different wallet. The pending request remains locked.",
        );
      }
      const matches =
        transaction.to?.toLowerCase() === submitted.to.toLowerCase() &&
        transaction.input === submitted.data &&
        transaction.value === 0n;
      // A manually supplied unrelated hash cannot clear an unresolved request.
      if (!matches && recoveringUnknown) {
        throw new IsolatedCreditError(
          "This transaction does not match the reviewed action. The pending request remains locked.",
        );
      }
      remember(null);
      setPending(null);
      setUncertain(false);
      setStep(null);
      resolved = true;
      if (receipt.status !== "success" || !matches) {
        throw new IsolatedCreditError(
          "The reviewed action reverted or was replaced. No successful completion was recorded.",
        );
      }
      await refresh();
      if (submitted.kind === "approval") {
        setMessage(
          "Approval confirmed. Review the next step; funds have not been deposited or borrowed yet.",
        );
        if (intent) await review(intent);
      } else {
        setInput("");
        setExtra("");
        if (mode === "earn" && (intent?.kind === "lend" || submitted.to.toLowerCase() === market.pool.toLowerCase() && (() => { try { return decodeFunctionData({abi: isolatedPoolAbi, data: submitted.data}).functionName.startsWith("deposit"); } catch { return false; } })())) {
          setDepositReceipt({hash: receipt.transactionHash, block: receipt.blockNumber});
          setMessage(rewardsForPool(market.pool) ? "USDG deposit confirmed. Finish TURRET reward activation above; lending alone does not activate rewards." : "USDG deposit confirmed. This pool has no active TURRET rewards integration.");
        } else setMessage("Transaction confirmed. Balances refresh automatically.");
      }
    } catch (e) {
      if (active.current) {
        setMessage(
          resolved
            ? ""
            : "Check the transaction in your wallet. Do not submit it again while its outcome is uncertain.",
        );
      }
      throw e;
    }
  }
  const actions: IsolatedIntent["kind"][] =
    mode === "earn"
      ? ["lend", "withdraw", "redeem", "redeemWorthless"]
      : [
          "depositBorrow",
          "borrow",
          "addCollateral",
          "removeCollateral",
          "repay",
          "close",
        ];
  let approvalAmount: bigint | undefined, spender: string | undefined;
  if (step?.kind === "approval") {
    const decoded = decodeFunctionData({ abi: erc20Abi, data: step.data });
    if (decoded.functionName === "approve") {
      spender = decoded.args[0];
      approvalAmount = decoded.args[1];
    }
  }
  const approvalUnit =
    step?.to.toLowerCase() === ISOLATED_USDG.toLowerCase()
      ? "USDG"
      : market.symbol;
  const ltv =
    state?.price && state.collateral > 0n
      ? (state.debt * 10n ** 30n * 10000n) / (state.collateral * state.price)
      : null;
  const liquidationCapacity = state?.price
    ? (((state.collateral * state.price) / 10n ** 18n) *
        BigInt(state.liquidationLtvBps)) /
      10000n /
      10n ** 12n
    : null;
  const risk =
    state?.debt === 0n
      ? "No debt"
      : liquidationCapacity === null
        ? "Risk data unavailable"
        : state!.debt > liquidationCapacity
          ? "Eligible for liquidation"
          : state!.debt * 100n >= liquidationCapacity * 97n
            ? "Critically close to liquidation"
            : state!.debt * 100n >= liquidationCapacity * 90n
              ? "Approaching liquidation"
              : "Below liquidation threshold";
  const atRisk =
    risk === "Eligible for liquidation" ||
    risk.includes("close") ||
    risk.includes("Approaching");
  const commissioning = market.admission === "commissioning";
  const marketClosed = mode === "borrow" && proofIssue?.code === "market_closed";
  const notice = wrongChain
    ? {
        title: "Switch to Robinhood Chain",
        body: "Choose Robinhood Chain in your wallet to view your balances and continue.",
      }
    : address && !state
      ? loadFailed
        ? {
            title: "We couldn’t load your balances",
            body: "Your position cannot be verified right now. Refresh to try again; transactions stay disabled until the data is available.",
          }
        : {
            title: "Loading your market and balances…",
            body: "Transaction controls will be available once your data has been verified.",
          }
      : commissioning
        ? {
            title: "This market is not open yet",
            body: "New deposits and loans are closed while final checks are completed. Existing repayments and withdrawals can still be reviewed.",
          }
        : marketClosed
            ? {
                title: "New loans are closed with the U.S. market",
                body: `Borrowing reopens ${reopeningText(proofIssue.reopensAt)}, when fresh ${market.symbol} prices can be verified. Repaying USDG and adding collateral remain available. A collateral deposit does not borrow USDG automatically.`,
              }
            : !address
              ? {
                  title: "Connect your wallet",
                  body: "Use the wallet button above to view your balances and manage your funds.",
                }
            : proofUnavailable || state?.price === null || state?.riskPaused
            ? {
                title:
                  mode === "borrow"
                    ? "New borrowing is temporarily unavailable"
                    : "Some market actions are temporarily unavailable",
                body:
                  mode === "borrow"
                    ? "You can still review a repayment or add collateral. Other actions depend on current market checks."
                    : "Deposits and withdrawals depend on current market checks and available USDG. Review an action to check whether it can proceed.",
              }
            : null;
  const borrowingUnavailable =
    (action === "borrow" || action === "depositBorrow") &&
    Boolean(proofUnavailable || state?.price === null || state?.riskPaused);
  const utilizationBps =
    state?.totalAssets && state.totalAssets > 0n
      ? (state.principal * 10000n) / state.totalAssets > 10000n
        ? 10000n
        : (state.principal * 10000n) / state.totalAssets
      : 0n;
  const estimateLenderApr = (utilization: bigint) => state
    ? (BigInt(state.aprBps) * utilization * BigInt(10000 - state.feeBps)) /
      100000000n
    : 0n;
  const lenderAprBps = estimateLenderApr(utilizationBps);
  function chooseAction(kind: IsolatedIntent["kind"], focusAmount = false) {
    setAction(kind);
    setInput("");
    setExtra("");
    setError("");
    if (focusAmount) amountField.current?.focus();
  }
  const hasLoan = Boolean(address && state && state.debt > 0n);
  const hasCollateral = Boolean(address && state && state.collateral > 0n);
  const actionLabel = (kind: IsolatedIntent["kind"]) => {
    if (kind === "depositBorrow") return hasLoan ? "Add collateral & borrow more" : "Deposit & borrow";
    if (kind === "borrow") return hasLoan ? "Borrow more USDG" : "Borrow against deposited collateral";
    return labels[kind];
  };
  const borrowerDescriptions: Partial<Record<IsolatedIntent["kind"], string>> = {
    depositBorrow: hasLoan
      ? `Deposit more ${market.symbol} and increase your existing USDG debt. This does not open a separate loan.`
      : `Deposit ${market.symbol} and receive USDG in your wallet. Your collateral backs the loan.`,
    borrow: `Receive more USDG using collateral already deposited. Debt increases; collateral stays the same.`,
    addCollateral: `Deposit ${market.symbol} to back your loan. Debt stays the same; you receive no USDG.`,
    removeCollateral: `Return some ${market.symbol} to your wallet. Debt stays the same, with less collateral backing it. Withdrawal limits apply.`,
    repay: "Pay back part of your USDG debt. Your collateral stays deposited.",
    close: `Repay all outstanding debt and return all deposited ${market.symbol} to your wallet.`,
  };
  const loanGroup = action === "repay" || action === "close"
    ? "repay" : action === "addCollateral" || action === "removeCollateral" ? "collateral" : "borrow";
  const loanVariants: { kind: IsolatedIntent["kind"]; label: string }[] = loanGroup === "repay"
    ? [{ kind: "repay", label: "Repay part" }, { kind: "close", label: "Repay all & close" }]
    : loanGroup === "collateral"
      ? [{ kind: "addCollateral", label: "Add collateral" }, { kind: "removeCollateral", label: "Withdraw collateral" }]
      : [{ kind: "depositBorrow", label: "Deposit collateral" }, { kind: "borrow", label: "Use deposited collateral" }];
  return (
    <main className="dockyard-isolated dockyard-market-page">
      <header className="dockyard-market-header">
        <div className="dockyard-market-title-row">
          <span className="dockyard-market-ticker">{market.symbol}</span>
          <span className="dockyard-market-chain">Robinhood Chain · 4663</span>
        </div>
        <h1>
          {mode === "earn"
            ? `Lend USDG to ${market.symbol} borrowers`
            : `Borrow USDG against ${market.symbol}`}
        </h1>
        <p>
          {mode === "earn"
            ? `You are the lender here. You deposit USDG and receive shares in this pool. Borrowers deposit ${collateralLabel} as collateral; you do not receive their tokens when you lend.`
            : `You are the borrower here. You deposit ${market.symbol} into the contract and receive USDG from the pool. You owe the loan plus interest; your collateral can be liquidated if the loan becomes unsafe.`}
        </p>
        <nav
          className="dockyard-market-tabs"
          aria-label={`${market.symbol} market`}
        >
          <a
            href={`/borrow?engine=${market.engine}`}
            aria-current={mode === "borrow" ? "page" : undefined}
          >
            <strong>Borrow</strong>
            <span>Use {market.symbol} as collateral</span>
          </a>
          <a
            href={`/earn?engine=${market.engine}`}
            aria-current={mode === "earn" ? "page" : undefined}
          >
            <strong>Earn</strong>
            <span>Lend USDG to this pool</span>
          </a>
        </nav>
      </header>
      {mode === "earn" && (
        <section
          className="dockyard-earn-flow"
          aria-labelledby="earn-flow-title"
        >
          <h2 id="earn-flow-title">Where your USDG goes</h2>
          <ol>
            <li>
              <strong>You deposit USDG</strong>
              <span>You receive shares in this {market.symbol} pool.</span>
            </li>
            <li>
              <strong>{market.symbol} holders borrow it</strong>
              <span>Their {collateralLabel} secure every loan.</span>
            </li>
            <li>
              <strong>Interest returns to the pool</strong>
              <span>After fees, it increases lender share value.</span>
            </li>
          </ol>
        </section>
      )}
      {mode === "earn" && state && (
        <section
          className="dockyard-earn-pool"
          aria-labelledby="earn-pool-title"
        >
          <h2 id="earn-pool-title">{market.symbol} pool right now</h2>
          <dl>
            <div>
              <dt><TermLabel topic="cash" helpLabel="Cash in this pool">Cash in this pool</TermLabel></dt>
              <dd>{units(state.cash)} USDG</dd>
            </div>
            <div>
              <dt><TermLabel topic="onLoan" helpLabel="Currently on loan">Currently on loan</TermLabel></dt>
              <dd>{units(state.principal)} USDG</dd>
            </div>
            <div>
              <dt><TermLabel topic="utilization" helpLabel="Pool utilization">Pool utilization</TermLabel></dt>
              <dd>{percentage(utilizationBps)}</dd>
            </div>
            <div>
              <dt><TermLabel topic="lenderApr" helpLabel="Estimated lender APR">Estimated lender APR</TermLabel></dt>
              <dd>{percentage(lenderAprBps)}</dd>
            </div>
          </dl>
          {state.principal === 0n && (
            <p className="dockyard-isolated-help">
              <strong>No active loans.</strong> Deposits earn borrower interest
              when borrowers use this pool.
            </p>
          )}
          <p className="dockyard-isolated-help">
            Borrowers pay {state.aprBps / 100}% APR. After the{" "}
            {state.feeBps / 100}% protocol share of interest, lender returns depend
            on how much of the pool is borrowed. Estimates exclude losses.
          </p>
          <p className="dockyard-isolated-help">
            Example only: at 80% utilization, estimated lender APR would be{" "}
            {percentage(estimateLenderApr(8000n))} with these rates and fees. This
            is not a forecast.
          </p>
        </section>
      )}
      <div className="dockyard-market-workspace">
        <div className="dockyard-market-overview">
          {notice && (
            <section
              className="dockyard-isolated-notice"
              aria-label="Market availability"
              role="status"
            >
              <h2>{notice.title}</h2>
              <p>{notice.body}</p>
              {marketClosed && address && state && action !== "addCollateral" && (
                <button
                  type="button"
                  className="dockyard-primary-action dockyard-notice-action"
                  disabled={busy || uncertain || Boolean(step)}
                  onClick={() => chooseAction("addCollateral", true)}
                >
                  Deposit {market.symbol} collateral now
                </button>
              )}
              {commissioning && !address && (
                <p>Connect your wallet to view an existing position.</p>
              )}
              {loadFailed && address && !wrongChain && (
                <button
                  type="button"
                  className="dockyard-secondary-action"
                  disabled={refreshing}
                  onClick={() => void refresh()}
                >
                  {refreshing ? "Refreshing balances…" : "Refresh balances"}
                </button>
              )}
            </section>
          )}
          {state && address && (
            <section
              aria-label="Market and position"
              className="dockyard-isolated-ledger"
              data-mode={mode}
            >
              <h2>
                {mode === "earn" ? "Your position in this pool" : "Your loan"}
              </h2>
              <dl>
                {(mode === "borrow" || address) && (
                  <div>
                    <dt>
                      <TermLabel topic={mode === "earn" ? "position" : "poolCollateral"} helpLabel={mode === "earn" ? "position value" : "collateral value"}>{mode === "earn"
                        ? "Estimated position value"
                        : "Your collateral"}</TermLabel>
                    </dt>
                    <dd>
                      {mode === "earn"
                        ? units(
                            (state.shares * (state.totalAssets + 1n)) /
                              (state.totalShares + 1000000n),
                          )
                        : units(state.collateral, 18)}{" "}
                      {mode === "earn" ? "USDG" : market.symbol}
                    </dd>
                  </div>
                )}
                {(mode === "borrow" || address) && (
                  <div>
                    <dt>
                      <TermLabel topic={mode === "earn" ? "withdrawable" : "poolDebt"} helpLabel={mode === "earn" ? "withdrawable balance" : "pool debt"}>{mode === "earn"
                        ? "Withdrawable now"
                        : "Debt including interest"}</TermLabel>
                    </dt>
                    <dd>
                      {units(mode === "earn" ? state.maxWithdraw : state.debt)}{" "}
                      USDG
                    </dd>
                  </div>
                )}
                {mode === "earn" && address && (
                  <div>
                    <dt><TermLabel topic="shares" helpLabel="Your lender shares">Your lender shares</TermLabel></dt>
                    <dd>{units(state.shares, 12)} shares</dd>
                  </div>
                )}
                {mode === "borrow" && (
                  <>
                    <div>
                      <dt>{market.symbol} available in your wallet</dt>
                      <dd>{units(state.collateralBalance, 18)} {market.symbol}</dd>
                    </div>
                    <div>
                      <dt><TermLabel topic="ltv" helpLabel="Current loan-to-value (LTV)">Current loan-to-value (LTV)</TermLabel></dt>
                      <dd>
                        {ltv === null ? "Unavailable" : `${Number(ltv) / 100}%`}
                      </dd>
                    </div>
                    <div>
                      <dt><TermLabel topic="liquidation" helpLabel="Liquidation threshold">Liquidation threshold</TermLabel></dt>
                      <dd>{state.liquidationLtvBps / 100}% LTV</dd>
                    </div>
                    <div>
                      <dt><TermLabel topic="borrowerApr" helpLabel="Borrower APR">Borrower APR</TermLabel></dt>
                      <dd>{state.aprBps / 100}%</dd>
                    </div>
                    <div>
                      <dt>Minimum loan</dt>
                      <dd>{units(state.minimumDebt)} USDG</dd>
                    </div>
                    <div>
                      <dt><TermLabel topic="capacity" helpLabel="Additional borrowing capacity">Additional borrowing capacity</TermLabel></dt>
                      <dd>{units(state.maxBorrow)} USDG</dd>
                    </div>
                  </>
                )}
                {mode === "borrow" && (
                  <div>
                    <dt>
                      Cash in this pool
                      <span className="dockyard-isolated-ledger-note">
                        Borrowing limits and market checks apply
                      </span>
                    </dt>
                    <dd>{units(state.cash)} USDG</dd>
                  </div>
                )}
              </dl>
              {mode === "earn" && address && (
                <>
                  <p className="dockyard-isolated-help">
                    Position value includes unpaid interest. Withdrawable now is
                    the USDG currently available to you, subject to transaction
                    checks.
                  </p>
                  <details className="dockyard-isolated-details">
                    <summary>How your return is calculated</summary>
                    <p>
                      Borrowers pay {state.aprBps / 100}% APR.{" "}
                      {state.feeBps / 100}% of received interest goes to
                      protocol fees.
                    </p>
                    <p>
                      Borrower APR is not lender APY. Your return depends on
                      pool usage, interest received and losses. It is not
                      guaranteed.
                    </p>
                    <p>
                      Withdrawals depend on available cash and loan health.
                      Liquidation shortfalls can reduce your position value.
                    </p>
                  </details>
                </>
              )}
              {mode === "borrow" && (
                <section
                  className="dockyard-isolated-risk"
                  data-urgent={atRisk || undefined}
                  aria-label="Loan health"
                  role={atRisk ? "alert" : "status"}
                >
                  <h3>{state.debt === 0n ? "No outstanding loan" : risk}</h3>
                  {state.debt > 0n && (
                    <p>
                      {risk === "Risk data unavailable"
                        ? "We can’t calculate your current risk without a verified price. You can still review a repayment."
                        : commissioning
                          ? "Repaying USDG lowers your LTV. Price gaps can leave little or no time to act."
                          : "Repaying USDG or adding collateral lowers your LTV. Price gaps can leave little or no time to act."}
                    </p>
                  )}
                  {state.debt > 0n && (
                    <div className="dockyard-isolated-shortcuts">
                      <button
                        type="button"
                        className="dockyard-secondary-action"
                        disabled={busy || uncertain || Boolean(step)}
                        onClick={() => chooseAction("repay", true)}
                      >
                        Repay loan
                      </button>
                      {!commissioning && (
                        <button
                          type="button"
                          className="dockyard-secondary-action"
                          disabled={busy || uncertain || Boolean(step)}
                          onClick={() => chooseAction("addCollateral", true)}
                        >
                          Add collateral
                        </button>
                      )}
                    </div>
                  )}
                </section>
              )}
            </section>
          )}
        </div>
        <section className="dockyard-isolated-action" aria-label="Manage funds">
          {mode === "earn" && <RewardsPanel pool={market.pool} onChanged={() => void refresh()} depositConfirmed={Boolean(depositReceipt)} depositBlock={depositReceipt?.block} refreshKey={depositReceipt?.hash} blocked={busy || uncertain || Boolean(step)} onBusyChange={setRewardsBusy} />}
          <div className="dockyard-isolated-action-heading">
            <h2>
              {mode === "earn"
                ? `Manage your ${market.symbol} pool position`
                : hasLoan ? "Manage your existing loan" : hasCollateral ? "Borrow against your collateral" : "Start your loan"}
            </h2>
            {mode === "earn" ? (
              <p>
                Deposit or withdraw USDG through the pool contract. Sending
                tokens directly does not create shares.
              </p>
            ) : null}
          </div>
          {!step && <p className="dockyard-isolated-action-explanation">{actionExplanation(action, market.symbol)}</p>}
          {!step && <WalletReadiness
            mode={mode}
            action={action}
            address={address}
            chainId={chainId}
            collateralSymbol={market.symbol}
            collateralAddress={market.collateral}
            isStockToken={Boolean(market.stock)}
            collateralBalance={state?.collateralBalance}
            usdgBalance={state?.cashBalance}
            balancesLoading={refreshing}
            balancesError={loadFailed}
            requiredTokenAmount={action === "depositBorrow" ? positiveAmount(extra, 18) || undefined
              : action === "addCollateral" ? positiveAmount(input, 18) || undefined
              : ["lend", "repay", "close"].includes(action) ? positiveAmount(input, 6) || undefined : undefined}
          />}
          {mode === "earn" && <LenderExitStatus
            connected={Boolean(address)}
            snapshot={!loadFailed && !wrongChain ? state : null}
            refreshing={refreshing}
            onRefresh={() => { void refresh(); }}
            onWithdraw={(amount) => {
              chooseAction("withdraw", true);
              setInput(formatUnits(amount, 6));
            }}
            disabled={busy || uncertain || Boolean(step) || wrongChain || !address}
          />}
          <form
            hidden={Boolean(step)}
            onSubmit={(e) => {
              e.preventDefault();
              void task(() => review());
            }}
          >
            <fieldset disabled={busy || rewardsBusy || uncertain || Boolean(step)}>
              {mode === "earn" ? (
                <>
              <label htmlFor="isolated-action">Action</label>
              <select
                id="isolated-action"
                value={action}
                onChange={(e) =>
                  chooseAction(e.target.value as IsolatedIntent["kind"])
                }
              >
                {actions.map((a) => (
                  <option key={a} value={a}>
                    {actionLabel(a)}
                  </option>
                ))}
              </select>
                </>
              ) : (
                <>
                  <div className="dockyard-loan-navigation" role="group" aria-label="Loan actions">
                    {([
                      { group: "borrow", label: hasLoan ? "Borrow more" : "Borrow", kind: hasCollateral ? "borrow" : "depositBorrow" },
                      { group: "repay", label: "Repay USDG", kind: "repay" },
                      { group: "collateral", label: "Collateral", kind: "addCollateral" },
                    ] as const).map(({ group, label, kind }) => (
                      <button
                        key={group}
                        type="button"
                        aria-pressed={loanGroup === group}
                        onClick={() => { if (loanGroup !== group) chooseAction(kind); }}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  <div className="dockyard-loan-variants" role="group" aria-label="How to manage your loan">
                    {loanVariants.map(({ kind, label }) => (
                      <label key={kind}>
                        <input
                          type="radio"
                          name="loan-operation"
                          checked={action === kind}
                          onChange={() => chooseAction(kind)}
                        />
                        <span>{label}</span>
                      </label>
                    ))}
                  </div>
                  <p className="dockyard-loan-explanation" aria-live="polite">
                    {borrowerDescriptions[action]}
                  </p>
                </>
              )}
              {action === "depositBorrow" && (
                <>
                  <label htmlFor="isolated-collateral">
                    Collateral to deposit · {market.symbol}
                  </label>
                  <input
                    id="isolated-collateral"
                    inputMode="decimal"
                    autoComplete="off"
                    value={extra}
                    onChange={(e) => setExtra(e.target.value)}
                  />
                  {state && (
                    <button
                      type="button"
                      className="dockyard-secondary-action dockyard-use-balance"
                      disabled={state.collateralBalance === 0n}
                      onClick={() => setExtra(formatUnits(state.collateralBalance, 18))}
                    >
                      Use wallet balance · {units(state.collateralBalance, 18)} {market.symbol}
                    </button>
                  )}
                </>
              )}
              <label htmlFor="isolated-amount">
                {amountLabels[action]} · {unit}
              </label>
              <input
                id="isolated-amount"
                ref={amountField}
                aria-describedby={
                  action === "close" ? "isolated-amount-help" : undefined
                }
                inputMode="decimal"
                autoComplete="off"
                value={input}
                onChange={(e) => setInput(e.target.value)}
              />
              {action === "close" && state && (
                <button
                  type="button"
                  className="dockyard-secondary-action"
                  onClick={() =>
                    setInput(
                      formatUnits(
                        state.debt +
                          (state.debt * BigInt(state.aprBps) * 300n +
                            315359999999n) /
                            315360000000n +
                          2n,
                        6,
                      ),
                    )
                  }
                >
                  Fill repayment amount
                </button>
              )}
              {action === "close" && (
                <p id="isolated-amount-help">
                  The suggested amount includes five minutes of interest. Only
                  the debt actually owed is taken.
                </p>
              )}
              {(action === "depositBorrow" || action === "borrow") && state && (
                <p className="dockyard-form-guidance">
                  Minimum total loan: {units(state.minimumDebt)} USDG. Your
                  wallet will first approve {market.symbol}, then ask you to
                  confirm the loan in a separate transaction.
                </p>
              )}
              {borrowingUnavailable && (
                <p className="dockyard-form-guidance" role="status">
                  A fresh {market.symbol} price is required to borrow. You can
                  choose Add collateral now and borrow after pricing reopens.
                </p>
              )}
              {marketClosed && action === "addCollateral" && (
                <p className="dockyard-form-guidance" role="status">
                  This locks {market.symbol} in the collateral contract without
                  borrowing USDG. Return after pricing reopens to review and
                  sign a separate loan transaction.
                </p>
              )}
              {action === "redeemWorthless" && (
                <p role="alert">
                  This surrenders shares after a complete recognized loss.
                  Expect no USDG in return.
                </p>
              )}
              <button
                className="dockyard-primary-action"
                disabled={
                  !state ||
                  !address ||
                  wrongChain ||
                  admissionBlocked(action) ||
                  borrowingUnavailable ||
                  !positiveAmount(input, decimals) ||
                  (action === "depositBorrow" && !positiveAmount(extra, 18))
                }
                type="submit"
              >
                Review {actionLabel(action).toLowerCase()}
              </button>
            </fieldset>
          </form>
          {step && (
            <section
              className="dockyard-isolated-review"
              aria-label="Review transaction"
            >
              <h2 ref={reviewHeading} tabIndex={-1}>
                {step.kind === "approval"
                  ? "Review token approval"
                  : "Review transaction"}
              </h2>
              <p>
                {step.kind === "approval"
                  ? `${approvalAmount === 0n ? "Reset allowance to" : "Approve up to"} ${units(
                      approvalAmount,
                      approvalUnit === "USDG" ? 6 : 18,
                    )} ${approvalUnit}. This does not complete ${actionLabel(step.intent.kind).toLowerCase()}.`
                  : `${actionLabel(step.intent.kind)}: ${units(step.intent.amount, decimals)} ${unit}.`}
              </p>
              <p className="dockyard-isolated-action-explanation">
                {step.kind === "approval"
                  ? "Approval only lets the named contract spend up to this token amount. It does not move the tokens or finish your action. A separate transaction follows."
                  : actionExplanation(step.intent.kind, market.symbol)}
              </p>
              {step.intent.kind === "depositBorrow" && (
                <p>
                  Collateral: {units(step.intent.collateralAmount, 18)}{" "}
                  {market.symbol}
                </p>
              )}
              {"minShares" in step.intent && (
                <p>
                  Minimum shares received: {units(step.intent.minShares, 12)}
                </p>
              )}
              {"maxShares" in step.intent && (
                <p>Maximum shares burned: {units(step.intent.maxShares, 12)}</p>
              )}
              {"minAssets" in step.intent && (
                <p>Minimum USDG received: {units(step.intent.minAssets)}</p>
              )}
              {"deadline" in step.intent && (
                <p>
                  Quote expires:{" "}
                  {new Date(
                    Number(step.intent.deadline) * 1000,
                  ).toLocaleTimeString()}
                </p>
              )}
              <details className="dockyard-isolated-details">
                <summary>Contract and network fee</summary>
                <p>
                  {spender ? "Spender" : "Contract"}: {spender ?? step.to}
                </p>
                <p>
                  Gas limit: {step.gas.toString()} units. Your wallet shows the
                  network fee.
                </p>
              </details>
              <button
                className="dockyard-primary-action"
                disabled={busy || uncertain || !address || wrongChain}
                onClick={() => void task(confirm)}
              >
                {busy
                  ? "Waiting for wallet or confirmation…"
                  : "Confirm in wallet"}
              </button>
              <button
                className="dockyard-secondary-action"
                disabled={busy}
                onClick={() => setStep(null)}
              >
                Back to edit
              </button>
            </section>
          )}
          {error && <p role="alert">{error}</p>}
          {message && <p role="status">{message}</p>}
          {hash && (
            <p>
              Transaction:{" "}
              {CHAIN_BLOCK_EXPLORER?.url ? (
                <a
                  href={`${CHAIN_BLOCK_EXPLORER.url.replace(/\/$/, "")}/tx/${hash}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  {hash}
                </a>
              ) : (
                hash
              )}
            </p>
          )}
          {uncertain && !busy && pending && (
            <>
              {!pending.hash && (
                <>
                  <label htmlFor="isolated-recovery">
                    Transaction hash from your wallet
                  </label>
                  <input
                    id="isolated-recovery"
                    value={recoveryHash}
                    onChange={(e) => setRecoveryHash(e.target.value)}
                    autoComplete="off"
                  />
                </>
              )}
              <button
                className="dockyard-secondary-action"
                disabled={
                  !pending.hash && !/^0x[\da-f]{64}$/i.test(recoveryHash)
                }
                onClick={() =>
                  void task(() =>
                    settle(
                      pending.hash
                        ? pending
                        : { ...pending, hash: recoveryHash as Hex },
                      undefined,
                      !pending.hash,
                    ),
                  )
                }
              >
                Check transaction confirmation
              </button>
            </>
          )}
        </section>
      </div>


      <details className="dockyard-isolated-details dockyard-isolated-identity">
        <summary>Market contracts</summary>
        <p>
          Engine: {market.engine}
          <br />
          Lender pool: {market.pool}
        </p>
      </details>
      {mode === "borrow" && (
        <BorrowerAlerts
          address={address}
          engine={market.engine}
          transactionHash={hash}
        />
      )}
    </main>
  );
}
