"use client";

import { dockyardErc20Abi, dockyardVaultAbi } from "@/src/abi/DockyardUSDGCreditVault";
import { DOCKYARD_USDG_ADDRESS, DOCKYARD_VAULT_ADDRESS, type DockyardMarket } from "@/src/dockyard-config";
import { useEffect, useMemo, useState } from "react";
import { formatUnits, parseUnits } from "viem";
import { useAccount, useReadContract, useWaitForTransactionReceipt, useWriteContract } from "wagmi";

const BPS = 10_000n;
const USDG_SCALE = 1_000_000_000_000n;

function parseAmount(value: string, decimals: number) {
  try {
    return value.trim() ? parseUnits(value, decimals) : 0n;
  } catch {
    return 0n;
  }
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
  const vaultAddress = DOCKYARD_VAULT_ADDRESS!;
  const { address, isConnected } = useAccount();
  const [collateralInput, setCollateralInput] = useState("");
  const [borrowInput, setBorrowInput] = useState("");
  const [pendingAction, setPendingAction] = useState<"approve-collateral" | "borrow" | "approve-usdg" | "close" | null>(
    null,
  );

  const collateralAmount = parseAmount(collateralInput, 18);
  const borrowAmount = parseAmount(borrowInput, 6);

  const paused = useReadContract({
    address: vaultAddress,
    abi: dockyardVaultAbi,
    functionName: "paused",
  });
  const liquidity = useReadContract({
    address: vaultAddress,
    abi: dockyardVaultAbi,
    functionName: "availableLiquidity",
  });
  const feeBps = useReadContract({
    address: vaultAddress,
    abi: dockyardVaultAbi,
    functionName: "originationFeeBps",
  });
  const price = useReadContract({
    address: vaultAddress,
    abi: dockyardVaultAbi,
    functionName: "price",
    args: [market.address],
  });
  const position = useReadContract({
    address: vaultAddress,
    abi: dockyardVaultAbi,
    functionName: "positions",
    args: [market.address, address ?? "0x0000000000000000000000000000000000000000"],
    query: { enabled: Boolean(address) },
  });
  const collateralBalance = useReadContract({
    address: market.address,
    abi: dockyardErc20Abi,
    functionName: "balanceOf",
    args: [address ?? "0x0000000000000000000000000000000000000000"],
    query: { enabled: Boolean(address) },
  });
  const collateralAllowance = useReadContract({
    address: market.address,
    abi: dockyardErc20Abi,
    functionName: "allowance",
    args: [address ?? "0x0000000000000000000000000000000000000000", vaultAddress],
    query: { enabled: Boolean(address) },
  });
  const usdgBalance = useReadContract({
    address: DOCKYARD_USDG_ADDRESS,
    abi: dockyardErc20Abi,
    functionName: "balanceOf",
    args: [address ?? "0x0000000000000000000000000000000000000000"],
    query: { enabled: Boolean(address) },
  });
  const usdgAllowance = useReadContract({
    address: DOCKYARD_USDG_ADDRESS,
    abi: dockyardErc20Abi,
    functionName: "allowance",
    args: [address ?? "0x0000000000000000000000000000000000000000", vaultAddress],
    query: { enabled: Boolean(address) },
  });

  const { data: transactionHash, error: writeError, isPending: walletPending, writeContractAsync, reset } =
    useWriteContract();
  const receipt = useWaitForTransactionReceipt({ hash: transactionHash });
  const refetchLiquidity = liquidity.refetch;
  const refetchPosition = position.refetch;
  const refetchCollateralBalance = collateralBalance.refetch;
  const refetchCollateralAllowance = collateralAllowance.refetch;
  const refetchUsdgBalance = usdgBalance.refetch;
  const refetchUsdgAllowance = usdgAllowance.refetch;

  useEffect(() => {
    if (!receipt.isSuccess) return;
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
    setPendingAction(null);
  }, [
    pendingAction,
    receipt.isSuccess,
    refetchCollateralAllowance,
    refetchCollateralBalance,
    refetchLiquidity,
    refetchPosition,
    refetchUsdgAllowance,
    refetchUsdgBalance,
  ]);

  const existingCollateral = position.data?.[0] ?? 0n;
  const existingDebt = position.data?.[1] ?? 0n;
  const displayedFeeBps = BigInt(feeBps.data ?? 0);
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
  const transactionPending = walletPending || receipt.isLoading;
  const hasBorrowValues = collateralAmount > 0n && borrowAmount > 0n;
  const borrowUnsafe = projectedLtvBps !== null && projectedLtvBps > market.maxLtvBps;
  const insufficientCollateral = collateralAmount > (collateralBalance.data ?? 0n);
  const insufficientLiquidity = borrowAmount > (liquidity.data ?? 0n);
  const canBorrow = isConnected && !paused.data && hasBorrowValues && !borrowUnsafe && !insufficientCollateral
    && !insufficientLiquidity && price.data !== undefined;

  async function approveCollateral() {
    reset();
    setPendingAction("approve-collateral");
    await writeContractAsync({
      address: market.address,
      abi: dockyardErc20Abi,
      functionName: "approve",
      args: [vaultAddress, collateralAmount],
    });
  }

  async function openPosition() {
    reset();
    setPendingAction("borrow");
    await writeContractAsync({
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
      address: vaultAddress,
      abi: dockyardVaultAbi,
      functionName: "repayAllAndWithdrawCollateral",
      args: [market.address, address],
    });
  }

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
          <p>One transaction locks your Stock Token and sends USDG to your wallet.</p>
        </div>
        <div className="dockyard-live-status" data-paused={paused.data || undefined}>
          <span />
          {paused.isLoading ? "Checking vault" : paused.data ? "Borrowing paused" : "Mainnet vault live"}
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
              <dd>{(market.maxLtvBps / 100).toFixed(1)}%</dd>
            </div>
            <div>
              <dt>Liquidation above</dt>
              <dd>{(market.liquidationLtvBps / 100).toFixed(1)}%</dd>
            </div>
            <div>
              <dt>One-time fee</dt>
              <dd>{(Number(displayedFeeBps) / 100).toFixed(2)}%</dd>
            </div>
          </dl>

          {borrowUnsafe && (
            <p className="dockyard-form-error">Lower the USDG amount. This loan exceeds the borrowing limit.</p>
          )}
          {insufficientCollateral && (
            <p className="dockyard-form-error">Your wallet does not have enough {market.symbol}.</p>
          )}
          {insufficientLiquidity && (
            <p className="dockyard-form-error">The vault does not have enough USDG for this loan.</p>
          )}
          {price.isError && (
            <p className="dockyard-form-error">The price checks are unavailable, so borrowing is blocked.</p>
          )}
          {transactionError(writeError) && <p className="dockyard-form-error">{transactionError(writeError)}</p>}
          {receipt.isSuccess && <p className="dockyard-form-success">Transaction confirmed on Robinhood Chain.</p>}

          <button
            className="dockyard-primary-action"
            disabled={!canBorrow || transactionPending}
            onClick={requiresCollateralApproval ? approveCollateral : openPosition}
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
            : existingCollateral === 0n && existingDebt === 0n
            ? <p className="dockyard-empty-position">No {market.symbol} position in this wallet.</p>
            : (
              <>
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
                  disabled={transactionPending || existingCollateral === 0n || (usdgBalance.data ?? 0n) < existingDebt}
                  onClick={requiresUsdgApproval ? approveUsdg : closePosition}
                  type="button"
                >
                  {transactionPending
                    ? "Confirming…"
                    : requiresUsdgApproval
                    ? "Approve USDG repayment"
                    : `Repay and reclaim ${market.symbol}`}
                </button>
              </>
            )}

          <div className="dockyard-exit-guarantee">
            <strong>Your exit stays available.</strong>
            <p>Full repayment and collateral withdrawal work in one transaction, even when new borrowing is paused.</p>
          </div>
        </aside>
      </div>
    </div>
  );
}
