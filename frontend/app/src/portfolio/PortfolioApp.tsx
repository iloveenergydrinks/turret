"use client";

import { useMemo } from "react";
import type { ReactNode } from "react";
import { P2PAppLayout } from "../p2p/P2PAppLayout";
import { AccountButton } from "../comps/AppLayout/AccountButton";
import { WalletProfileEditor } from "../profiles/WalletProfileEditor";
import { useWalletSession } from "../wallet/useWalletSession";
import "../screens/P2PLoansScreen/p2p.css";
import { createPortfolioSources } from "./source";
import { UnifiedPortfolio } from "./UnifiedPortfolio";
import { BorrowerCashbackPanel } from "../borrower-cashback/CashbackPortfolio";

/** Mount inside WalletSessionProvider so the incumbent connector options persist. */
export function PortfolioApp({ profile }: { profile?: ReactNode }) {
  const wallet = useWalletSession();
  const sources = useMemo(() => createPortfolioSources(), []);
  return (
    <P2PAppLayout
      activePage="portfolio"
      network="Robinhood Chain"
      wallet={<AccountButton />}
    >
      <UnifiedPortfolio
        account={wallet.account}
        chainId={wallet.chainId}
        sources={sources}
        connecting={wallet.connecting}
        walletError={wallet.error}
        onConnect={() => void wallet.connect()}
        onDisconnect={wallet.disconnect}
        profile={profile ?? (wallet.account
          ? <WalletProfileEditor address={wallet.account} provider={wallet.provider} chainId={wallet.chainId} />
          : undefined)}
      />
      <BorrowerCashbackPanel />
    </P2PAppLayout>
  );
}
