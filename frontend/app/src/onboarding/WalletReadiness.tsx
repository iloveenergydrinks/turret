"use client";

import { useId } from "react";
import { formatUnits, type Address } from "viem";
import { useBalance } from "wagmi";
import { getWalletReadiness, ROBINHOOD_CHAIN_ID, type ReadinessAction } from "./readiness";
import styles from "./WalletReadiness.module.css";
import "./workspace.css";

const officialLinks = {
  network: "https://docs.robinhood.com/chain/add-network-to-wallet/",
  bridge: "https://docs.robinhood.com/chain/bridging/",
  transfers: "https://robinhood.com/us/en/support/articles/crypto-transfers/",
  stockTokens: "https://robinhood.com/rhj/stocktokens/",
  wallet: "https://robinhood.com/us/en/support/articles/send-receive-and-swap-crypto/",
  contracts: "https://docs.robinhood.com/chain/contracts/",
} as const;

export type WalletReadinessProps = {
  mode: "borrow" | "earn";
  action?: ReadinessAction;
  address?: Address;
  chainId?: number;
  collateralSymbol: string;
  collateralAddress: Address;
  collateralDecimals?: number;
  isStockToken?: boolean;
  collateralBalance?: bigint;
  usdgBalance?: bigint;
  requiredTokenAmount?: bigint;
  balancesLoading?: boolean;
  balancesError?: boolean;
};

export function WalletReadiness({
  mode,
  action = mode === "earn" ? "lend" : "depositBorrow",
  address,
  chainId,
  collateralSymbol,
  collateralAddress,
  collateralDecimals = 18,
  isStockToken = false,
  collateralBalance,
  usdgBalance,
  requiredTokenAmount,
  balancesLoading = false,
  balancesError = false,
}: WalletReadinessProps) {
  const titleId = useId();
  const native = useBalance({
    address,
    chainId: ROBINHOOD_CHAIN_ID,
    query: {
      enabled: Boolean(address && chainId === ROBINHOOD_CHAIN_ID),
      staleTime: 15_000,
      refetchInterval: 30_000,
      refetchOnWindowFocus: true,
    },
  });
  const readiness = getWalletReadiness({
    connected: Boolean(address),
    chainId,
    action,
    collateralBalance,
    usdgBalance,
    requiredTokenAmount,
    balancesError,
    nativeBalance: native.data?.value,
    nativeBalanceError: native.isError,
  });
  const tokenSymbol = readiness.token === "usdg" ? "USDG" : collateralSymbol;
  const decimals = readiness.token === "usdg" ? 6 : collateralDecimals;
  const tokenBalance = readiness.tokenBalance === undefined ? null : formatUnits(readiness.tokenBalance, decimals);
  const repayment = action === "repay" || action === "close";
  const setupMissing = !address || chainId !== ROBINHOOD_CHAIN_ID;

  return (
    <section className={styles.readiness} aria-labelledby={titleId}>
      <h2 id={titleId} className={styles.heading}>Before you continue</h2>
      <dl className={styles.checks}>
        <div>
          <dt>Wallet</dt>
          <dd>
            {address
              ? <span>Connected: <span className={styles.address}>{address.slice(0, 6)}…{address.slice(-4)}</span></span>
              : <span>Use <strong>Connect</strong> in the page header.</span>}
          </dd>
        </div>
        <div>
          <dt>Network</dt>
          <dd>
            {readiness.networkStatus === "available"
              ? "Robinhood Chain · 4663"
              : <span>Choose Robinhood Chain (4663). <a href={officialLinks.network} target="_blank" rel="noopener noreferrer">Network setup ↗</a></span>}
          </dd>
        </div>
        <div>
          <dt>{readiness.token === null ? "Token funding" : tokenSymbol}</dt>
          <dd aria-live="polite">
            {readiness.token === null
              ? "No additional wallet tokens are needed for this action."
              : setupMissing
                ? `Connect on Robinhood Chain to check your ${tokenSymbol}.`
                : readiness.tokenStatus === "unknown"
                  ? balancesLoading && !balancesError
                    ? `Checking ${tokenSymbol} balance…`
                    : `${tokenSymbol} balance unavailable. Refresh the market before continuing.`
                  : <>
                    <span className={styles.balance}>{tokenBalance} {tokenSymbol} in wallet.</span>{" "}
                    {readiness.tokenStatus === "needed"
                      ? readiness.requiredTokenAmount !== undefined && readiness.tokenBalance !== undefined && readiness.tokenBalance > 0n
                        ? "Add enough to cover the entered amount."
                        : `Add ${tokenSymbol} to this wallet before ${repayment ? "repaying" : mode === "earn" ? "lending" : "depositing collateral"}.`
                      : readiness.requiredTokenAmount === undefined ? "Check the amount you enter against this balance." : "Covers the entered amount."}
                  </>}
          </dd>
        </div>
        <div>
          <dt>ETH for fees</dt>
          <dd aria-live="polite">
            {setupMissing
              ? "Keep ETH on Robinhood Chain for wallet transactions."
              : readiness.gasStatus === "unknown"
                ? native.isPending && !native.isError
                  ? "Checking ETH balance…"
                  : "ETH balance unavailable. Check your wallet on Robinhood Chain."
                : readiness.gasStatus === "needed"
                  ? "Add ETH on Robinhood Chain to pay for approvals and wallet transactions."
                  : <><span className={styles.balance}>{formatUnits(readiness.nativeBalance!, 18)} ETH available.</span>{" "}Check your wallet’s fee estimate before confirming.</>}
          </dd>
        </div>
      </dl>
      <details className={styles.help}>
        <summary>Get assets, use USDG and prepare repayment</summary>
        <div className={styles.instructions}>
          <p>
            <strong>ETH and USDG.</strong>{" "}
            For supported transfers to your wallet, follow{" "}
            <a href={officialLinks.transfers} target="_blank" rel="noopener noreferrer">Robinhood’s transfer instructions ↗</a>.{" "}
            If your assets are on another network, use the{" "}
            <a href={officialLinks.bridge} target="_blank" rel="noopener noreferrer">official bridging guide ↗</a>{" "}
            to check available routes. Confirm Robinhood Chain as the destination and compare the received USDG address with the{" "}
            <a href={officialLinks.contracts} target="_blank" rel="noopener noreferrer">canonical token registry ↗</a>.
          </p>
          {readiness.token === "collateral" ? (
            <p>
              <strong>{collateralSymbol} collateral.</strong>{" "}
              {isStockToken
                ? <><a href={officialLinks.stockTokens} target="_blank" rel="noopener noreferrer">Robinhood’s Stock Token information ↗</a>{" "}explains availability and eligibility. </>
                : "Use a provider that supports this exact token on Robinhood Chain. "}
              Match the token’s contract to{" "}
              <a className={styles.address} href={`https://robinhoodchain.blockscout.com/address/${collateralAddress}`} target="_blank" rel="noopener noreferrer">
                {collateralAddress} ↗
              </a>. A matching ticker on another network is a different asset.
            </p>
          ) : null}
          <p>
            <strong>Using borrowed USDG.</strong>{" "}
            USDG arrives in your wallet on Robinhood Chain. Before transferring it, check that the receiving wallet, app or exchange supports that token and network.{" "}
            <a href={officialLinks.wallet} target="_blank" rel="noopener noreferrer">Robinhood Wallet’s send and receive guide ↗</a>{" "}
            explains its supported transfers. Provider eligibility, fees and availability apply.
          </p>
          <p>
            <strong>Repayment.</strong>{" "}
            Return enough USDG for your debt and accrued interest to this wallet on Robinhood Chain, keep ETH for fees, then use the loan’s Repay action.
            Allow time for transfers before you need to repay. A canonical bridge withdrawal to Ethereum has a seven-day challenge period.{" "}
            <a href="https://docs.turret.capital/getting-started#using-usdg-and-preparing-repayment" target="_blank" rel="noopener noreferrer">Read the repayment checklist ↗</a>
          </p>
          <p className={styles.note}>External guides open in a new tab. Check the current route and token before moving funds.</p>
        </div>
      </details>
    </section>
  );
}
