import Link from "next/link";
import { AboutButton } from "./AboutButton";

export function BottomBar() {
  return (
    <footer className="rusd-footer">
      <div className="rusd-frame rusd-footer-inner">
        <span>Independent Stock Token credit protocol · Testnet preview</span>
        <div className="rusd-footer-links">
          <Link className="rusd-text-link" href="/redeem">Redeem rUSD</Link>
          <a
            className="rusd-text-link"
            href="https://github.com/iloveenergydrinks/liquityv3"
            rel="noreferrer"
            target="_blank"
          >
            GitHub
          </a>
          <AboutButton />
        </div>
      </div>
    </footer>
  );
}
