import { BorrowHero } from "./BorrowHero";
import { BorrowNavigation } from "./BorrowNavigation";

/** One introduction and tab position across every borrowing route. */
export function BorrowPageHeader({ active, persistent = false }: { active: "pools" | "p2p" | "nfts"; persistent?: boolean }) {
  const experience = useContext(BorrowExperienceContext);
  if (experience && !persistent) return null;
  return <>
    <BorrowHero theme={active} />
    <BorrowNavigation active={active} />
    <p className="borrow-pool-summary">
      {active === "pools" ? <><strong>Pool loans:</strong> borrow from available pool liquidity at market-set terms. Your collateral can be liquidated if its value falls too far. With <a href="/borrow/p2p">P2P loans</a>, you agree fixed interest and a deadline with another person.</>
        : active === "p2p" ? <><strong>P2P stocks and memes:</strong> use your tokens as collateral and agree fixed interest and a repayment deadline with a lender. There is no price-triggered liquidation. If you miss the final deadline, the lender can claim your collateral.</>
        : <><strong>P2P NFTs:</strong> use a supported NFT as collateral and agree fixed interest and a repayment deadline with a lender. Repay to recover your NFT. If you miss the final deadline, the lender can claim it.</>}
    </p>
  </>;
}
import { useContext } from "react";
import { BorrowExperienceContext } from "./BorrowExperienceContext";
