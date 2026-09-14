import type { ReactNode } from "react";
import { TechnologyLogos } from "./TechnologyLogos";
import { XLink } from "./XLink";
import { AGENT_BRIEF_URL } from "@/src/agent-brief-config";
import { blogHref } from "@/src/blog-config";
import "../../../public/turret-footer-v2.css";

export function SiteFooter({
  description = "Independent collateral lending protocol · Robinhood Chain mainnet",
  children,
}: { description?: string; children?: ReactNode }) {
  return (
    <footer className="rusd-footer turret-footer">
      <div className="rusd-frame rusd-footer-inner">
        <div className="turret-footer-brand">
          <span className="turret-footer-description">{description}</span>
          <div className="turret-footer-contact">
            <XLink />
            <a className="rusd-text-link" href="mailto:support@turret.capital">support@turret.capital</a>
          </div>
          <TechnologyLogos />
        </div>
        <div className="rusd-footer-links">
          <nav className="turret-footer-group turret-footer-resources" aria-label="Footer resources">
            <h2>Resources</h2>
            <a className="rusd-text-link" href={blogHref()}>Blog</a>
            <a className="rusd-text-link" href="https://docs.turret.capital/">Documentation</a>
            <a className="rusd-text-link" href={AGENT_BRIEF_URL}>Agent brief</a>
            {children}
          </nav>
          <nav className="turret-footer-group turret-footer-legal" aria-label="Footer legal">
            <h2>Legal</h2>
            <a className="rusd-text-link" href="/terms">Terms</a>
            <a className="rusd-text-link" href="https://docs.turret.capital/platform/risks">Risk</a>
            <a className="rusd-text-link" href="/privacy" data-turret-legal="/privacy">Privacy</a>
            <a className="rusd-text-link" href="/cookies" data-turret-legal="/cookies">Cookies</a>
            <button type="button" className="turret-cookie-settings" data-cookie-settings="">Cookie settings</button>
          </nav>
        </div>
      </div>
    </footer>
  );
}
