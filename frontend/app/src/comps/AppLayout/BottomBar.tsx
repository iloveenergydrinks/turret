import Link from "next/link";
import { AboutButton } from "./AboutButton";

import { CHAIN_NAME } from "@/src/env";

export function BottomBar() {
  return (
    <footer className="rusd-footer">
      <div className="rusd-frame rusd-footer-inner">
        <span>Independent Stock Token credit protocol · {CHAIN_NAME}</span>
        <div className="rusd-footer-links">
          <Link className="rusd-text-link" href="/redeem">Redeem rUSD</Link>
          <AboutButton />
        </div>
      </div>
    </footer>
  );
}
