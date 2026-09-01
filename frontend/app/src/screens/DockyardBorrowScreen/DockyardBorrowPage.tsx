"use client";

import { getDockyardMarket } from "@/src/dockyard-config";
import { useSearchParams } from "next/navigation";
import { DockyardBorrowScreen } from "./DockyardBorrowScreen";

export function DockyardBorrowPage() {
  const searchParams = useSearchParams();
  const market = getDockyardMarket(searchParams.get("market") ?? "aapl") ?? getDockyardMarket("aapl");
  if (!market) return null;
  return <DockyardBorrowScreen market={market} />;
}
