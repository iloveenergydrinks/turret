import { useState } from "react";
import logos from "../../p2p/collateral-logos.json";
import "./CollateralLogo.css";

/** Match the chain and collateral contract, never an untrusted symbol alone. */
export function CollateralLogo({ market }: { market: { chainId: number; collateralToken: string; collateralSymbol: string } }) {
  const src = (logos as Record<string, string>)[`${market.chainId}:${(market.collateralToken ?? "").toLowerCase()}`];
  const [failed, setFailed] = useState<string | null>(null);
  return <span className="p2p-collateral-logo" aria-hidden="true">
    {src && failed !== src ? <img src={src} alt="" width={32} height={32} loading="lazy" onError={() => setFailed(src)} /> : <span>{market.collateralSymbol.slice(0, 2)}</span>}
  </span>;
}
