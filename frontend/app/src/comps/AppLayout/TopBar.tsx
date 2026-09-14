"use client";

import { Logo } from "@/src/comps/Logo/Logo";
import { CHAIN_ID, CHAIN_NAME } from "@/src/env";
import { usePathname } from "next/navigation";
import { AccountButton } from "./AccountButton";
import { HeaderNavigation } from "./HeaderNavigation";

const links = [
  { href: "/borrow", label: "Borrow" },
  { href: "/earn", label: "Earn" },
  { href: "/stake", label: "Stake" },
  { href: "/portfolio", label: "Portfolio" },
] as const;

export function TopBar() {
  // Native links preserve navigation across independently released static pages.
  const pathname = usePathname();

  return (
    <header className="rusd-topbar">
      <div className="rusd-frame rusd-topbar-inner">
        <a aria-label="Turret home" className="rusd-brand-link" href="/">
          <Logo size={36} />
        </a>
        <HeaderNavigation>
          {links.map(({ href, label }) => {
            const active = href === "/borrow"
              ? pathname === "/" || pathname.startsWith("/borrow") || pathname.startsWith("/p2p")
              : pathname.startsWith(href);
            return (
              <a
                aria-current={active ? "page" : undefined}
                className="rusd-nav-link"
                data-active={active}
                href={href}
                key={href}
              >
                {label}
              </a>
            );
          })}
        </HeaderNavigation>
        <div className="rusd-account">
          <span className="rusd-network" title={`${CHAIN_NAME} · Chain ID ${CHAIN_ID}`}>
            <span aria-hidden="true" className="rusd-network-dot" />
            <span className="rusd-network-name">{CHAIN_NAME}</span>
          </span>
          <AccountButton />
        </div>
      </div>
    </header>
  );
}
