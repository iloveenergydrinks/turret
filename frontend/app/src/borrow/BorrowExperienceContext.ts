import { createContext } from "react";

export type BorrowTab = "p2p" | "nfts" | "pools";
export const borrowPaths: Record<BorrowTab, string> = {
  p2p: "/borrow/p2p", nfts: "/borrow/nfts", pools: "/borrow/pools",
};
export function tabForPath(path: string): BorrowTab {
  return path === "/borrow/nfts" || path === "/p2p/nfts" ? "nfts" : path === "/borrow/pools" ? "pools" : "p2p";
}
export const BorrowExperienceContext = createContext<{
  navigate: (tab: BorrowTab) => void;
  preload: (tab: BorrowTab) => void;
} | null>(null);
