import Link from "next/link";
import { AboutButton } from "./AboutButton";
import { SiteFooter } from "./SiteFooter";
import { CHAIN_NAME } from "@/src/env";

export function BottomBar() {
  return (
    <SiteFooter description={`Independent collateral lending protocol · ${CHAIN_NAME}`}>
      <Link className="rusd-text-link" href="/redeem">Redeem rUSD</Link>
      <AboutButton />
    </SiteFooter>
  );
}
