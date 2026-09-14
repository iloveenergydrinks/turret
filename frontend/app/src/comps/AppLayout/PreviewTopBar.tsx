"use client";

import { Logo } from "@/src/comps/Logo/Logo";
import { CHAIN_ID, CHAIN_NAME } from "@/src/env";
import { usePathname } from "next/navigation";
import { AccountButton } from "./AccountButton";
import { HeaderNavigation } from "./HeaderNavigation";

export function PreviewTopBar({ interactive = false }: { interactive?: boolean }) {
  const pathname = usePathname();
  const borrowActive = pathname === "/" || pathname.startsWith("/borrow") || pathname.startsWith("/p2p");
  const earnActive = pathname === "/earn" || pathname.startsWith("/earn/");
  const portfolioActive = pathname === "/portfolio" || pathname.startsWith("/portfolio/");
  // Static routes can be released independently; document navigation avoids
  // sharing an incompatible Next/RSC module graph across release bundles.
  return (
    <header className="rusd-topbar">
      <div className="rusd-frame rusd-topbar-inner rusd-topbar-preview">
        <a aria-label="Turret home" className="rusd-brand-link" href="/">
          <Logo size={36} />
        </a>
        <HeaderNavigation>
          <a
            aria-current={borrowActive ? "page" : undefined}
            className="rusd-nav-link"
            data-active={borrowActive}
            href="/borrow"
          >
            Borrow
          </a>
          <a
            aria-current={earnActive ? "page" : undefined}
            className="rusd-nav-link"
            data-active={earnActive}
            href="/earn"
          >
            Earn
          </a>
          <a aria-current={pathname.startsWith("/stake") ? "page" : undefined} className="rusd-nav-link" data-active={pathname.startsWith("/stake")} href="/stake">Stake</a>
          <a
            aria-current={portfolioActive ? "page" : undefined}
            className="rusd-nav-link"
            data-active={portfolioActive}
            href="/portfolio"
          >
            Portfolio
          </a>
        </HeaderNavigation>
        <div className="rusd-account">
          <span className="rusd-network" title={`${CHAIN_NAME} · Chain ID ${CHAIN_ID}`}>
            <span aria-hidden="true" className="rusd-network-dot" />
            <span className="rusd-network-name">{CHAIN_NAME}</span>
          </span>
          {interactive && <AccountButton />}
        </div>
      </div>
    </header>
  );
}
