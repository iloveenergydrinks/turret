import { getBorrowStaticParams } from "@/src/deployment-config";
import { DOCKYARD_STANDALONE_DEPLOYMENT, getDockyardMarket } from "@/src/dockyard-config";
import { DockyardBorrowScreen } from "@/src/screens/DockyardBorrowScreen/DockyardBorrowScreen";
import { notFound } from "next/navigation";

export function generateStaticParams() {
  return getBorrowStaticParams();
}

export default async function BorrowCollateralPage({ params }: { params: Promise<{ collateral: string }> }) {
  if (!DOCKYARD_STANDALONE_DEPLOYMENT) return null;
  const { collateral } = await params;
  const market = getDockyardMarket(collateral);
  if (!market) notFound();
  return <DockyardBorrowScreen market={market} />;
}
