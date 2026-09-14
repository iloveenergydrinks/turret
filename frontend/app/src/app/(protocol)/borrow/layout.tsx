import { READ_ONLY_DEPLOYMENT } from "@/src/deployment-config";
import { DOCKYARD_STANDALONE_DEPLOYMENT } from "@/src/dockyard-config";
import { BorrowScreen } from "@/src/screens/BorrowScreen/BorrowScreen";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { ISOLATED_MARKETS } from "@/src/isolated-market-config";

export default function BorrowLayout({ children }: { children: ReactNode }) {
  if (READ_ONLY_DEPLOYMENT) {
    redirect("/");
  }

  if (DOCKYARD_STANDALONE_DEPLOYMENT || ISOLATED_MARKETS.length) return children;

  return <BorrowScreen />;
}
