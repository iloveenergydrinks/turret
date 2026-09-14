import { SiteFooter } from "./SiteFooter";

export function PreviewBottomBar({ interactive = false }: { interactive?: boolean }) {
  return <SiteFooter description={interactive
    ? "Independent collateral lending protocol · Robinhood Chain mainnet"
    : "Independent collateral lending protocol · No live contracts"} />;
}
