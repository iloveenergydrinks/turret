"use client";

import { dockyardErc20Abi, dockyardVaultAbi } from "@/src/abi/DockyardUSDGCreditVault";
import { DOCKYARD_USDG_ADDRESS, DOCKYARD_VAULT_ADDRESS, type DockyardMarket } from "@/src/dockyard-config";
import { useEffect, useMemo, useState } from "react";
import { formatUnits } from "viem";
import { useAccount, useReadContract, useWaitForTransactionReceipt, useWriteContract } from "wagmi";
import { WalletHistory } from "./WalletHistory";
import { PositionHealth } from "./PositionHealth";
import { BorrowerAlerts } from "./BorrowerAlerts";
import { positiveAmount } from "@/src/dockyard-amount";
import { fetchRiskApproval } from "@/src/dockyard-risk-approval";

const BPS = 10_000n;
const USDG_SCALE = 1_000_000_000_000n;

function parseAmount(value: string, decimals: number) {
  return positiveAmount(value, decimals);
}

function formatAmount(value: bigint | undefined, decimals: number, precision = 4) {
  if (value === undefined) return "—";
  const formatted = Number(formatUnits(value, decimals));
  return formatted.toLocaleString(undefined, { maximumFractionDigits: precision });
}

function transactionError(error: Error | null) {
  if (!error) return null;
  const firstLine = error.message.split("\n")[0] ?? "Transaction failed.";
  if (firstLine.includes("User rejected")) return "Transaction cancelled in your wallet.";
  return firstLine.replace("ContractFunctionExecutionError: ", "");
}

export function DockyardBorrowScreen({ market }: { market: DockyardMarket }) {
  const { address } = useAccount();
  return <BorrowPosition key={`${address ?? "disconnected"}:${market.address}`} market={market} />;
}

function BorrowPosition({ market }: { market: DockyardMarket }) {
  const vaultAddress = DOCKYARD_VAULT_ADDRESS!;
  const riskMonitor = process.env.NEXT_PUBLIC_DOCKYARD_RISK_MONITOR_URL;
  const [riskReady, setRiskReady] = useState(false);
  const [riskError, setRiskError] = useState<string | null>(null);
  const [checkingRisk, setCheckingRisk] = useState(false);
  const { address, isConnected, chainId } = useAccount();
  const wrongChain = isConnected && chainId !== 4663;
  const [collateralInput, setCollateralInput] = useState("");
  const [borrowInput, setBorrowInput] = useState("");
  const [topUpInput, setTopUpInput] = useState("");
  const [repayInput, setRepayInput] = useState("");
  const topUpAmount = positiveAmount(topUpInput, 18);
  const repayAmount = positiveAmount(repayInput, 6);
  const [pendingAction, setPendingAction] = useState<"approve-collateral" | "borrow" | "approve-usdg" | "close" | "top-up" | "repay" | null>(
    null,
  );

  const collateralAmount = parseAmount(collateralInput, 18);
  const borrowAmount = parseAmount(borrowInput, 6);

  const paused = useReadContract({
    chainId: 4663,
    address: vaultAddress,
    abi: dockyardVaultAbi,
    functionName: "paused",
  });
  const liquidity = useReadContract({
    chainId: 4663,
    address: vaultAddress,
    abi: dockyardVaultAbi,
    functionName: "availableLiquidity",
  });
  const feeBps = useReadContract({
    chainId: 4663,
    address: vaultAddress,
    abi: dockyardVaultAbi,
    functionName: "originationFeeBps",
  });
  const price = useReadContract({
    chainId: 4663,
    address: vaultAddress,
    abi: dockyardVaultAbi,
    functionName: "price",
    args: [market.address],
    query: { refetchInterval: 12000 },
  });
  const liveMarket = useReadContract({ chainId: 4663, address: vaultAddress, abi: dockyardVaultAbi, functionName: "markets", args: [market.address], query: { refetchInterval: 12000 } });
  const borrowerAllowed = useReadContract({ chainId: 4663, address: vaultAddress, abi: dockyardVaultAbi, functionName: "borrowerAllowed", args: [address ?? "0x0000000000000000000000000000000000000000"], query: { enabled: Boolean(riskMonitor && address), refetchInterval: 12000 } });
  const globalDebtCeiling = useReadContract({ chainId: 4663, address: vaultAddress, abi: dockyardVaultAbi, functionName: "globalDebtCeiling", query: { enabled: Boolean(riskMonitor), refetchInterval: 12000 } });
  const totalDebt = useReadContract({ chainId: 4663, address: vaultAddress, abi: dockyardVaultAbi, functionName: "totalDebt", query: { enabled: Boolean(riskMonitor), refetchInterval: 12000 } });
  const marketDebt = useReadContract({ chainId: 4663, address: vaultAddress, abi: dockyardVaultAbi, functionName: "marketDebt", args: [market.address], query: { enabled: Boolean(riskMonitor), refetchInterval: 12000 } });
  const adapter = liveMarket.data?.[1];
  useEffect(() => {
    if (!riskMonitor || !adapter) return;
    let active = true;
    const check = async () => {
      try { await fetchRiskApproval(riskMonitor, vaultAddress, market.address, adapter); if (active) setRiskReady(true); }
      catch { if (active) setRiskReady(false); }
    };
    void check();
    const timer = setInterval(check, 12000);
    return () => { active = false; clearInterval(timer); };
  }, [riskMonitor, vaultAddress, market.address, adapter]);
  const position = useReadContract({
    chainId: 4663,
    address: vaultAddress,
    abi: dockyardVaultAbi,
    functionName: "positions",
    args: [market.address, address ?? "0x0000000000000000000000000000000000000000"],
    query: { enabled: Boolean(address), refetchInterval: 12000 },
  });
  const collateralBalance = useReadContract({
    chainId: 4663,
    address: market.address,
    abi: dockyardErc20Abi,
    functionName: "balanceOf",
    args: [address ?? "0x0000000000000000000000000000000000000000"],
    query: { enabled: Boolean(address) },
  });
  const collateralAllowance = useReadContract({
    chainId: 4663,
    address: market.address,
    abi: dockyardErc20Abi,
    functionName: "allowance",
    args: [address ?? "0x0000000000000000000000000000000000000000", vaultAddress],
    query: { enabled: Boolean(address) },
  });
  const usdgBalance = useReadContract({
    chainId: 4663,
    address: DOCKYARD_USDG_ADDRESS,
    abi: dockyardErc20Abi,
    functionName: "balanceOf",
    args: [address ?? "0x0000000000000000000000000000000000000000"],
    query: { enabled: Boolean(address) },
  });
  const usdgAllowance = useReadContract({
    chainId: 4663,
    address: DOCKYARD_USDG_ADDRESS,
    abi: dockyardErc20Abi,
    functionName: "allowance",
    args: [address ?? "0x0000000000000000000000000000000000000000", vaultAddress],
    query: { enabled: Boolean(address) },
  });

  const { data: transactionHash, error: writeError, isPending: walletPending, writeContractAsync, reset } =
    useWriteContract();
  const receipt = useWaitForTransactionReceipt({ chainId: 4663, hash: transactionHash });
  const refetchLiquidity = liquidity.refetch;
  const refetchPosition = position.refetch;
  const refetchCollateralBalance = collateralBalance.refetch;
  const refetchCollateralAllowance = collateralAllowance.refetch;
  const refetchUsdgBalance = usdgBalance.refetch;
  const refetchUsdgAllowance = usdgAllowance.refetch;

  useEffect(() => {
    if (!receipt.isSuccess || receipt.data?.status !== "success") return;
    void Promise.all([
      refetchLiquidity(),
      refetchPosition(),
      refetchCollateralBalance(),
      refetchCollateralAllowance(),
      refetchUsdgBalance(),
      refetchUsdgAllowance(),
    ]);
    if (pendingAction === "borrow") {
      setCollateralInput("");
      setBorrowInput("");
    }
    if (pendingAction === "top-up") setTopUpInput("");
    if (pendingAction === "repay") setRepayInput("");
    setPendingAction(null);
  }, [
    pendingAction,
    receipt.isSuccess,
    receipt.data?.status,
    refetchCollateralAllowance,
    refetchCollateralBalance,
    refetchLiquidity,
    refetchPosition,
    refetchUsdgAllowance,
    refetchUsdgBalance,
  ]);

  const existingCollateral = position.data?.[0] ?? 0n;
  const existingDebt = position.data?.[1] ?? 0n;
  const manageUnavailable = wrongChain || position.isError || position.data === undefined;
  const topUpNeedsApproval = topUpAmount > (collateralAllowance.data ?? 0n);
  const repayNeedsApproval = repayAmount > (usdgAllowance.data ?? 0n);
  const displayedFeeBps = BigInt(feeBps.data ?? 0);
  const maxLtvBps = liveMarket.data?.[3];
  const liquidationLtvBps = liveMarket.data?.[4];
  const debtIncrease = borrowAmount + (borrowAmount * displayedFeeBps + BPS - 1n) / BPS;

  const projectedLtvBps = useMemo(() => {
    if (!price.data) return null;
    const collateralValue18 = ((existingCollateral + collateralAmount) * price.data) / 10n ** 18n;
    if (collateralValue18 === 0n) return null;
    const debt18 = (existingDebt + debtIncrease) * USDG_SCALE;
    return Number((debt18 * BPS) / collateralValue18);
  }, [collateralAmount, debtIncrease, existingCollateral, existingDebt, price.data]);

  const requiresCollateralApproval = collateralAmount > (collateralAllowance.data ?? 0n);
  const requiresUsdgApproval = existingDebt > (usdgAllowance.data ?? 0n);
  const transactionPending = checkingRisk || walletPending || receipt.isLoading;
  const hasBorrowValues = collateralAmount > 0n && borrowAmount > 0n;
  const borrowUnsafe = projectedLtvBps !== null && maxLtvBps !== undefined && projectedLtvBps > maxLtvBps;
  const insufficientCollateral = collateralAmount > (collateralBalance.data ?? 0n);
  const insufficientLiquidity = borrowAmount > (liquidity.data ?? 0n);
  const vaultReadUnavailable = paused.isError || liquidity.isError || feeBps.isError || price.isError || liveMarket.isError;
  const pilotLimitExceeded = Boolean(riskMonitor) && (globalDebtCeiling.data === undefined || totalDebt.data === undefined || marketDebt.data === undefined || liveMarket.data === undefined
    || totalDebt.data + debtIncrease > globalDebtCeiling.data || marketDebt.data + debtIncrease > liveMarket.data[2]);
  const pilotUnavailable = Boolean(riskMonitor) && (!riskReady || borrowerAllowed.data !== true || pilotLimitExceeded);
  const canBorrow = isConnected && !wrongChain && paused.data === false && hasBorrowValues && !borrowUnsafe && !insufficientCollateral
    && !insufficientLiquidity && price.data !== undefined && maxLtvBps !== undefined && liveMarket.data?.[9] === true && !vaultReadUnavailable && !manageUnavailable && !pilotUnavailable;

  async function approveCollateral() {
    reset();
    setPendingAction("approve-collateral");
    await writeContractAsync({
      chainId: 4663,
      address: market.address,
      abi: dockyardErc20Abi,
      functionName: "approve",
      args: [vaultAddress, collateralAmount],
    });
  }

  async function openPosition() {
    reset();
    setRiskError(null);
    setPendingAction("borrow");
    if (riskMonitor) {
      setCheckingRisk(true);
      try {
        if (!adapter) throw new Error("Market unavailable.");
        const proof = await fetchRiskApproval(riskMonitor, vaultAddress, market.address, adapter);
        await writeContractAsync({ chainId: 4663, address: vaultAddress, abi: dockyardVaultAbi, functionName: "depositAndBorrowChecked", args: [market.address, collateralAmount, borrowAmount, proof] });
      } catch {
        setRiskError("Borrowing could not complete. Refresh the check and try again; repayment and top-ups remain available.");
        setPendingAction(null);
      } finally { setCheckingRisk(false); }
      return;
    }
    await writeContractAsync({
      chainId: 4663,
      address: vaultAddress,
      abi: dockyardVaultAbi,
      functionName: "depositAndBorrow",
      args: [market.address, collateralAmount, borrowAmount],
    });
  }

  async function approveUsdg() {
    reset();
    setPendingAction("approve-usdg");
    await writeContractAsync({
      chainId: 4663,
      address: DOCKYARD_USDG_ADDRESS,
      abi: dockyardErc20Abi,
      functionName: "approve",
      args: [vaultAddress, existingDebt],
    });
  }

  async function closePosition() {
    if (!address) return;
    reset();
    setPendingAction("close");
    await writeContractAsync({
      chainId: 4663,
      address: vaultAddress,
      abi: dockyardVaultAbi,
      functionName: "repayAllAndWithdrawCollateral",
      args: [market.address, address],
    });
  }

  async function protectPosition(action: "top-up" | "repay") {
    if (!address || wrongChain) return;
    reset();
    const approval = action === "top-up" ? topUpNeedsApproval : repayNeedsApproval;
    setPendingAction(approval ? action === "top-up" ? "approve-collateral" : "approve-usdg" : action);
    if (approval) {
      await writeContractAsync({ chainId: 4663, address: action === "top-up" ? market.address : DOCKYARD_USDG_ADDRESS, abi: dockyardErc20Abi, functionName: "approve", args: [vaultAddress, action === "top-up" ? topUpAmount : repayAmount] });
    } else if (action === "top-up") {
      await writeContractAsync({ chainId: 4663, address: vaultAddress, abi: dockyardVaultAbi, functionName: "depositCollateral", args: [market.address, topUpAmount] });
    } else {
      await writeContractAsync({ chainId: 4663, address: vaultAddress, abi: dockyardVaultAbi, functionName: "repay", args: [market.address, address, repayAmount] });
    }
  }

  // wagmi exposes rejected writes through writeError; prevent unhandled promises.
  const submit = (action: () => Promise<void>) => { void action().catch(() => setPendingAction(null)); };

  const submitLabel = !isConnected
    ? "Connect your wallet above"
    : paused.data
    ? "Borrowing is paused"
    : requiresCollateralApproval
    ? `Approve ${market.symbol}`
    : "Deposit and borrow USDG";

  return (
    <div className="dockyard-borrow">
      <header className="dockyard-borrow-heading">
        <div>
          <a className="dockyard-back" href="/">← Markets</a>
          <h1>Borrow USDG with {market.symbol}.</h1>
          <p>You are the borrower. Your tokens go into the contract as collateral; the loan sends USDG to your wallet. You owe the USDG plus interest. Collateral can be liquidated if your loan becomes unsafe.</p>
          <p>One transaction locks your Stock Token and sends USDG to your wallet.</p>
        </div>
        <div className="dockyard-live-status" data-paused={paused.data || vaultReadUnavailable || undefined}>
          <span />
          {paused.isLoading
            ? "Checking vault"
            : vaultReadUnavailable
            ? "Vault connection unavailable"
            : paused.data
            ? "Borrowing paused"
            : "Mainnet vault live"}
        </div>
      </header>

      <div className="dockyard-borrow-grid">
        <section className="dockyard-borrow-form" aria-labelledby="open-position-title">
          <div className="dockyard-panel-title">
            <div>
              <h2 id="open-position-title">Open a position</h2>
              <p>{market.name} Stock Token · Robinhood Chain</p>
            </div>
            <span>{market.symbol}</span>
          </div>

          <label className="dockyard-amount-field">
            <span>Stock Token collateral</span>
            <div>
              <input
                autoComplete="off"
                inputMode="decimal"
                onChange={(event) => setCollateralInput(event.target.value)}
                placeholder="0.00"
                value={collateralInput}
              />
              <strong>{market.symbol}</strong>
            </div>
            <small>Wallet: {formatAmount(collateralBalance.data, 18)} {market.symbol}</small>
          </label>

          <label className="dockyard-amount-field">
            <span>USDG to borrow</span>
            <div>
              <input
                autoComplete="off"
                inputMode="decimal"
                onChange={(event) => setBorrowInput(event.target.value)}
                placeholder="0.00"
                value={borrowInput}
              />
              <strong>USDG</strong>
            </div>
            <small>Vault liquidity: {formatAmount(liquidity.data, 6, 2)} USDG</small>
          </label>

          <dl className="dockyard-borrow-summary">
            <div>
              <dt>Projected LTV</dt>
              <dd>{projectedLtvBps === null ? "—" : `${(projectedLtvBps / 100).toFixed(2)}%`}</dd>
            </div>
            <div>
              <dt>Borrowing limit</dt>
              <dd>{maxLtvBps === undefined ? "—" : `${(maxLtvBps / 100).toFixed(1)}%`}</dd>
            </div>
            <div>
              <dt>Liquidation above</dt>
              <dd>{liquidationLtvBps === undefined ? "—" : `${(liquidationLtvBps / 100).toFixed(1)}%`}</dd>
            </div>
            <div>
              <dt>One-time fee</dt>
              <dd>{(Number(displayedFeeBps) / 100).toFixed(2)}%</dd>
            </div>
          </dl>

          {riskMonitor && borrowerAllowed.data === false && <p className="dockyard-form-error">This pilot is available to approved wallets.</p>}
          {riskMonitor && !riskReady && <p className="dockyard-form-error">Borrowing is temporarily unavailable. You can still repay debt.</p>}
          {riskMonitor && pilotLimitExceeded && hasBorrowValues && <p className="dockyard-form-error">This amount exceeds the remaining pilot borrowing capacity, or capacity could not be checked.</p>}
          {riskError && <p className="dockyard-form-error">{riskError}</p>}

          {borrowUnsafe && (
            <p className="dockyard-form-error">Lower the USDG amount. This loan exceeds the borrowing limit.</p>
          )}
          {insufficientCollateral && (
            <p className="dockyard-form-error">Your wallet does not have enough {market.symbol}.</p>
          )}
          {insufficientLiquidity && (
            <p className="dockyard-form-error">The vault does not have enough USDG for this loan.</p>
          )}
          {vaultReadUnavailable && (
            <p className="dockyard-form-error">The vault connection is unavailable, so borrowing is blocked.</p>
          )}
          {transactionError(writeError) && <p className="dockyard-form-error">{transactionError(writeError)}</p>}
          {wrongChain && <p className="dockyard-form-error" role="alert">Switch your wallet to Robinhood Chain to manage this position.</p>}
          {(receipt.isError || receipt.data?.status === "reverted") && <p className="dockyard-form-error" role="alert">{receipt.data?.status === "reverted" ? "Transaction reverted. Your intended action did not complete." : "Transaction confirmation is unavailable. Check your wallet before retrying."}</p>}
          {receipt.isSuccess && receipt.data?.status === "success" && <p className="dockyard-form-success">Transaction confirmed on Robinhood Chain.</p>}

          <button
            className="dockyard-primary-action"
            disabled={!canBorrow || transactionPending}
            onClick={() => submit(requiresCollateralApproval ? approveCollateral : openPosition)}
            type="button"
          >
            {transactionPending ? "Confirming…" : submitLabel}
          </button>
          <p className="dockyard-action-note">
            You keep the price exposure, but the token remains locked until the debt is repaid.
          </p>
        </section>

        <aside className="dockyard-position-panel" aria-labelledby="your-position-title">
          <div className="dockyard-panel-title">
            <div>
              <h2 id="your-position-title">Your position</h2>
              <p>Repay in full to reclaim the collateral.</p>
            </div>
          </div>

          {!isConnected
            ? <p className="dockyard-empty-position">Connect your wallet to see and manage your position.</p>
            : position.data === undefined
            ? <p className="dockyard-empty-position" role="status">{position.isError ? "Position unavailable. We cannot determine your debt or liquidation risk. Please retry when the connection recovers." : "Loading your position…"}</p>
            : existingCollateral === 0n && existingDebt === 0n
            ? <p className="dockyard-empty-position">No {market.symbol} position in this wallet.</p>
            : (
              <>
                <PositionHealth collateral={existingCollateral} debt={existingDebt} price={price.data} liquidationLtvBps={liveMarket.data?.[4]} updatedAt={Math.min(price.dataUpdatedAt, position.dataUpdatedAt, liveMarket.dataUpdatedAt)} unavailable={price.isError || position.isError || liveMarket.isError} />
                <dl className="dockyard-position-values">
                  <div>
                    <dt>Collateral</dt>
                    <dd>{formatAmount(existingCollateral, 18)} {market.symbol}</dd>
                  </div>
                  <div>
                    <dt>Debt to repay</dt>
                    <dd>{formatAmount(existingDebt, 6, 6)} USDG</dd>
                  </div>
                  <div>
                    <dt>Wallet USDG</dt>
                    <dd>{formatAmount(usdgBalance.data, 6, 6)} USDG</dd>
                  </div>
                </dl>

                {(usdgBalance.data ?? 0n) < existingDebt && (
                  <p className="dockyard-form-error">
                    You need {formatAmount(existingDebt - (usdgBalance.data ?? 0n), 6, 6)} more USDG to close.
                  </p>
                )}

                <button
                  className="dockyard-secondary-action"
                  disabled={transactionPending || manageUnavailable || usdgBalance.isError || usdgAllowance.isError || existingCollateral === 0n || (usdgBalance.data ?? 0n) < existingDebt}
                  onClick={() => submit(requiresUsdgApproval ? approveUsdg : closePosition)}
                  type="button"
                >
                  {transactionPending
                    ? "Confirming…"
                    : requiresUsdgApproval
                    ? "Approve USDG repayment"
                    : `Repay and reclaim ${market.symbol}`}
                </button>
                <div className="dockyard-protect">
                  <h3>Reduce your risk</h3>
                  <label className="dockyard-amount-field"><span>Add {market.symbol} collateral</span><input aria-label={`Add ${market.symbol} collateral`} inputMode="decimal" value={topUpInput} onChange={e => setTopUpInput(e.target.value)} placeholder="0.00" /></label>
                  <button className="dockyard-secondary-action" type="button" disabled={transactionPending || manageUnavailable || price.isError || !price.data || collateralBalance.isError || paused.data !== false || liveMarket.data?.[9] !== true || !topUpAmount || topUpAmount > (collateralBalance.data ?? 0n) || collateralAllowance.isError} onClick={() => submit(() => protectPosition("top-up"))}>{topUpNeedsApproval ? `Approve ${market.symbol} top-up` : "Add collateral"}</button>
                  {paused.data && <p className="dockyard-help">Collateral deposits are paused. You can still repay debt.</p>}
                  <label className="dockyard-amount-field"><span>Repay some USDG</span><input aria-label="USDG to repay" inputMode="decimal" value={repayInput} onChange={e => setRepayInput(e.target.value)} placeholder="0.00" /></label>
                  <button className="dockyard-secondary-action" type="button" disabled={transactionPending || manageUnavailable || usdgBalance.isError || !repayAmount || repayAmount > existingDebt || repayAmount > (usdgBalance.data ?? 0n) || usdgAllowance.isError} onClick={() => submit(() => protectPosition("repay"))}>{repayNeedsApproval ? "Approve partial repayment" : "Repay USDG"}</button>
                  <p className="dockyard-help">Use a positive amount within your wallet balance. Repayment cannot exceed your debt. Neither action borrows more USDG; you confirm each transaction in your wallet.</p>
                </div>
              </>
            )}

          <div className="dockyard-exit-guarantee">
            <strong>Your exit stays available.</strong>
            <p>Full repayment and collateral withdrawal work in one transaction, even when new borrowing is paused.</p>
          </div>
        </aside>
      </div>
      <BorrowerAlerts address={address} transactionHash={transactionHash} />
      <WalletHistory address={address} confirmedTransaction={receipt.isSuccess ? transactionHash : undefined} />
    </div>
  );
}
