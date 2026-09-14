"use client";

import { useMemo } from "react";
import { createPortfolioSources } from "../../portfolio/source";
import { UnifiedPortfolio } from "../../portfolio/UnifiedPortfolio";
import { WalletProfileEditor } from "../../profiles/WalletProfileEditor";
import { useWalletSession } from "../../wallet/useWalletSession";

/** The protocol route already provides the application shell and wallet providers. */
export function PortfolioScreen() {
  const wallet = useWalletSession();
  const sources = useMemo(() => createPortfolioSources(), []);

  return (
    <UnifiedPortfolio
      account={wallet.account}
      chainId={wallet.chainId}
      sources={sources}
      connecting={wallet.connecting}
      walletError={wallet.error}
      onConnect={() => void wallet.connect()}
      onDisconnect={wallet.disconnect}
      profile={wallet.account
        ? <WalletProfileEditor address={wallet.account} provider={wallet.provider} chainId={wallet.chainId} />
        : undefined}
    />
  );
}
