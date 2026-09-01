import { Logo } from "@/src/comps/Logo/Logo";
import Link from "next/link";

export function PreviewTopBar() {
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
          <span className="rusd-preview-badge">USDG preview · not live</span>
        </div>
      </div>
    </header>
  );
}
