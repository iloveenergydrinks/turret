import { SiteFooter } from "../comps/AppLayout/SiteFooter";
import "../app/beta-notice.css";
import "../app/controls.css";
import type { ReactNode } from "react";
import { HeaderNavigation } from "../comps/AppLayout/HeaderNavigation";

/** The independent release uses the existing protocol shell's classes and navigation. */
export function P2PAppLayout(
  { children, wallet, network, activePage = "p2p" }: {
    children: ReactNode;
    wallet: ReactNode;
    network: string;
    activePage?: "p2p" | "borrow" | "earn" | "portfolio";
  },
) {
  return (
    <>
      <aside className="turret-beta-notice" aria-label="Open beta notice">
        <p>
          <strong>Turret is in open beta.</strong> We recommend starting with small amounts.
        </p>
      </aside>
      <div className="rusd-shell p2p-app-shell">
        <header className="rusd-topbar">
          <div className="rusd-frame rusd-topbar-inner rusd-topbar-preview">
            <a aria-label="Turret home" className="rusd-brand-link" href="/">
              <span aria-label="Turret" className="dockyard-logo" role="img" style={{ height: 36 }}>
                <span aria-hidden="true" className="dockyard-logo-mark-frame" style={{ height: 36, width: 36 }}>
                  <img alt="" className="dockyard-logo-mark" src="/brand/turret-mark.svg" height="36" width="36" />
                </span>
                <span className="dockyard-logo-wordmark" style={{ fontSize: 23.76 }}>turret.</span>
              </span>
            </a>
            <HeaderNavigation>
              <a className="rusd-nav-link" href="/borrow" data-active={activePage === "p2p" || activePage === "borrow"} aria-current={activePage === "p2p" || activePage === "borrow" ? "page" : undefined}>Borrow</a>
              <a className="rusd-nav-link" href="/earn" data-active={activePage === "earn"} aria-current={activePage === "earn" ? "page" : undefined}>Earn</a>
              <a
                className="rusd-nav-link"
                href="/portfolio"
                data-active={activePage === "portfolio"}
                aria-current={activePage === "portfolio" ? "page" : undefined}
              >
                Portfolio
              </a>
            </HeaderNavigation>
            <div className="rusd-account">
              <span className="rusd-network" title={network}>
                <span aria-hidden="true" className="rusd-network-dot" />
                <span className="rusd-network-name">{network}</span>
              </span>
              <div className="dockyard-wallet-control">{wallet}</div>
            </div>
          </div>
        </header>
        <main className="rusd-frame rusd-main">{children}</main>
        <SiteFooter />
      </div>
    </>
  );
}
