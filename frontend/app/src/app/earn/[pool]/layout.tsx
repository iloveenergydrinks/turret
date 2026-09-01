import { EarnPoolScreen } from "@/src/screens/EarnPoolScreen/EarnPoolScreen";
import { SboldPoolScreen } from "@/src/screens/EarnPoolScreen/SboldPoolScreen";
import { getEarnPoolStaticParams } from "@/src/deployment-config";

export function generateStaticParams() {
  return getEarnPoolStaticParams();
}

export default async function Layout({
  params,
}: {
  params: Promise<{
    pool: string;
  }>;
}) {
  const { pool } = await params;
  return pool === "sbold"
    ? <SboldPoolScreen />
    : <EarnPoolScreen />;
}
