import { useContext } from "react";
import { BorrowExperienceContext } from "./BorrowExperienceContext";
import "./borrow.css";
export type BorrowKind = "overview" | "pools" | "p2p" | "nfts";
export function BorrowNavigation({active}: {active: BorrowKind}) {
  const experience = useContext(BorrowExperienceContext);
  return <nav className="borrow-navigation" aria-label="Loan types">
    {([
      ["p2p", "/borrow/p2p", "P2P stocks and memes"],
      ["nfts", "/borrow/nfts", "P2P NFTs"],
      ["pools", "/borrow/pools", "Pool loans"],
    ] as const).map(([id,href,label]) => <a key={id} href={href}
      onPointerEnter={() => experience?.preload(id)} onFocus={() => experience?.preload(id)}
      onClick={event => {
        if (!experience || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault(); experience.navigate(id);
      }} aria-current={(active === id || active === "overview" && id === "p2p") ? "page" : undefined}>{label}</a>)}
  </nav>;
}
