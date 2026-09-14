"use client";

import { BorrowNavigation } from "../../borrow/BorrowNavigation";
import { BorrowHub } from "../../borrow/BorrowHub";
import { getDockyardMarket } from "@/src/dockyard-config";
import { useSearchParams } from "next/navigation";
import { DockyardBorrowScreen } from "./DockyardBorrowScreen";
import { IsolatedMarketRoute } from "../IsolatedMarketScreen/IsolatedMarketScreen";
import { ISOLATED_MARKETS } from "@/src/isolated-market-config";

export function DockyardBorrowPage() {
  const searchParams = useSearchParams();
  if (searchParams.has("engine")) {
    const engines=searchParams.getAll("engine");
    return <><BorrowNavigation active="pools" /><IsolatedMarketRoute engine={engines.length===1?engines[0]!:""} mode="borrow" /></>;
  }
  if (!searchParams.has("market")) return <BorrowHub />;
  const market = getDockyardMarket(searchParams.get("market") ?? "aapl") ?? getDockyardMarket("aapl");
  if (!market) return null;
  const currentMarket = ISOLATED_MARKETS.find(m => m.symbol === market.symbol);
  if (currentMarket) return <><BorrowNavigation active="pools" /><IsolatedMarketRoute engine={currentMarket.engine} mode="borrow" /></>;
  return <><BorrowNavigation active="pools" /><DockyardBorrowScreen market={market} /></>;
}
