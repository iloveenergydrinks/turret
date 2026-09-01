"use client";

import { Logo } from "@/src/comps/Logo/Logo";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { AccountButton } from "./AccountButton";

const links = [
  { href: "/", label: "Markets" },
  { href: "/earn", label: "Earn" },
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
          <span className="rusd-network">
            <span className="rusd-network-dot" />
            Testnet
          </span>
          <AccountButton />
        </div>
      </div>
    </header>
  );
}
