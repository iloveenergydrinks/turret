import { getBorrowStaticParams } from "@/src/deployment-config";
import { DOCKYARD_STANDALONE_DEPLOYMENT, getDockyardMarket } from "@/src/dockyard-config";
import { DockyardBorrowScreen } from "@/src/screens/DockyardBorrowScreen/DockyardBorrowScreen";
import { notFound } from "next/navigation";
import { ISOLATED_MARKETS } from "@/src/isolated-market-config";
import { IsolatedMarketRoute } from "@/src/screens/IsolatedMarketScreen/IsolatedMarketScreen";

export function generateStaticParams() {
  return getBorrowStaticParams();
}

export default async function BorrowCollateralPage({ params }: { params: Promise<{ collateral: string }> }) {
  if (!DOCKYARD_STANDALONE_DEPLOYMENT) return null;
  const { collateral } = await params;
  const market = getDockyardMarket(collateral);
  if (!market) notFound();
  const currentMarket = ISOLATED_MARKETS.find(m => m.symbol === market.symbol);
  if (currentMarket) return <IsolatedMarketRoute engine={currentMarket.engine} mode="borrow" />;
  return <DockyardBorrowScreen market={market} />;
}
