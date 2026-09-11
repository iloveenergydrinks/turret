import { XLink } from "./XLink";

export function PreviewBottomBar({ interactive = false }: { interactive?: boolean }) {
  return (
    <footer className="rusd-footer">
      <div className="rusd-frame rusd-footer-inner">
        <span>
          {interactive
            ? "Independent Stock Token credit protocol · Robinhood Chain mainnet"
            : "Independent Stock Token credit protocol · No live contracts"}
        </span>
        <div className="rusd-footer-links">
          <XLink />
        </div>
      </div>
    </footer>
  );
}
