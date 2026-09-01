"use client";

import { Logo } from "@/src/comps/Logo/Logo";
import { CHAIN_ID, CHAIN_NAME } from "@/src/env";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { AccountButton } from "./AccountButton";

const links = [
  { href: "/", label: "Markets" },
  { href: "/#how-it-works", label: "How it works" },
] as const;

export function TopBar() {
  const pathname = usePathname();

  return (
    <header className="rusd-topbar">
      <div className="rusd-frame rusd-topbar-inner">
        <Link aria-label="Dockyard markets" className="rusd-brand-link" href="/">
          <Logo size={36} />
        </Link>
        <nav aria-label="Primary" className="rusd-nav">
          {links.map(({ href, label }) => {
            const active = href === "/" ? pathname === "/" : pathname.startsWith(href);
            return (
              <Link className="rusd-nav-link" data-active={active} href={href} key={href}>
                {label}
              </Link>
            );
          })}
        </nav>
        <div className="rusd-account">
          <span className="rusd-network" title={`Chain ID ${CHAIN_ID}`}>
            <span className="rusd-network-dot" />
            <span className="rusd-network-name">{CHAIN_NAME}</span>
            <span className="rusd-network-name-short">RH Testnet</span>
          </span>
          <AccountButton />
        </div>
      </div>
    </header>
  );
}
