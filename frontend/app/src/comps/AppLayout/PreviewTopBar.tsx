"use client";

import { Logo } from "@/src/comps/Logo/Logo";
import { CHAIN_ID, CHAIN_NAME } from "@/src/env";
import Link from "next/link";
import { AccountButton } from "./AccountButton";

export function PreviewTopBar({ interactive = false }: { interactive?: boolean }) {
  return (
    <header className="rusd-topbar">
      <div className="rusd-frame rusd-topbar-inner rusd-topbar-preview">
        <Link aria-label="Dockyard markets" className="rusd-brand-link" href="/">
          <Logo size={36} />
        </Link>
        <nav aria-label="Primary" className="rusd-nav">
          <Link className="rusd-nav-link" data-active="true" href="/">Markets</Link>
        </nav>
        <div className="rusd-account">
          <span className="rusd-network" title={`Chain ID ${CHAIN_ID}`}>
            <span className="rusd-network-dot" />
            <span className="rusd-network-name">{CHAIN_NAME}</span>
            <span className="rusd-network-name-short">Robinhood</span>
          </span>
          {interactive && <AccountButton />}
        </div>
      </div>
    </header>
  );
}
