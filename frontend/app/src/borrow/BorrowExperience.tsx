"use client";

import { Component, lazy, Suspense, useEffect, useMemo, useState, type ReactNode } from "react";
import { AccountButton } from "../comps/AppLayout/AccountButton";
import { P2PAppLayout } from "../p2p/P2PAppLayout";
import { WalletSessionProvider } from "../wallet/useWalletSession";
import { BorrowPageHeader } from "./BorrowPageHeader";
import { borrowPaths, BorrowExperienceContext, tabForPath, type BorrowTab } from "./BorrowExperienceContext";

const loadP2P = () => import("../screens/P2PLoansScreen/P2PLoansScreen");
const loadNFTs = () => import("../nft/NFTLoansScreen");
const loadPools = () => import("./PoolLoanDirectory");
const P2P = lazy(() => loadP2P().then(m => ({ default: m.P2PLoansScreen })));
const NFTs = lazy(() => loadNFTs().then(m => ({ default: m.NFTLoansScreen })));
const Pools = lazy(() => loadPools().then(m => ({ default: m.PoolLoanDirectory })));
const labels = { p2p: "P2P stocks and memes", nfts: "P2P NFTs", pools: "Pool loans" };

class ContentBoundary extends Component<{ children: ReactNode; tab: BorrowTab }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    return this.state.failed ? <p role="alert">This loan section could not load. <a href={borrowPaths[this.props.tab]}>Reload {labels[this.props.tab]}</a>.</p> : this.props.children;
  }
}

/** One wallet, header and WebGL canvas for every borrowing URL. */
export function BorrowExperience({ initialTab = "p2p", standalone = false }: { initialTab?: BorrowTab; standalone?: boolean }) {
  const content = <BorrowContent initialTab={initialTab} />;
  return standalone ? <WalletSessionProvider>
    <P2PAppLayout activePage="borrow" network="Robinhood Chain" wallet={<AccountButton />}>{content}</P2PAppLayout>
  </WalletSessionProvider> : content;
}

function BorrowContent({ initialTab }: { initialTab: BorrowTab }) {
  const [active, setActive] = useState(initialTab);
  useEffect(() => {
    const read = () => setActive(tabForPath(window.location.pathname));
    read();
    window.addEventListener("popstate", read);
    return () => window.removeEventListener("popstate", read);
  }, []);
  useEffect(() => {
    document.title = window.location.pathname === "/" ? "Turret | Borrow against memecoins, stocks and NFTs"
      : `${labels[active]} | Turret`;
  }, [active]);
  const navigation = useMemo(() => ({
    navigate(tab: BorrowTab) {
      if (tab === tabForPath(window.location.pathname)) return;
      window.history.pushState(window.history.state, "", borrowPaths[tab]);
      setActive(tab);
    },
    preload(tab: BorrowTab) {
      void ({ p2p: loadP2P, nfts: loadNFTs, pools: loadPools }[tab])().catch(() => {});
    },
  }), []);
  return <BorrowExperienceContext.Provider value={navigation}>
    <div className="borrow-hub" data-borrow-experience="persistent">
      <BorrowPageHeader active={active} persistent />
      <section aria-label={labels[active]} data-loan-content={active}>
        <ContentBoundary key={active} tab={active}>
          <Suspense fallback={<p role="status">Loading {labels[active]}…</p>}>
            {active === "p2p" ? <P2P /> : active === "nfts" ? <NFTs embedded sharedWallet /> : <Pools />}
          </Suspense>
        </ContentBoundary>
      </section>
    </div>
  </BorrowExperienceContext.Provider>;
}
