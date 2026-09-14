import { BorrowNavigation } from "../borrow/BorrowNavigation";
export function NFTProductNavigation({ active }: { active: "tokens" | "nfts" }) {
  return <BorrowNavigation active={active === "tokens" ? "p2p" : "nfts"} />;
}
