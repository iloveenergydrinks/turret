import { DEPLOYMENT_FEATURES } from "@/src/deployment-config";
import { StakeScreen } from "@/src/screens/StakeScreen/StakeScreen";
import { notFound } from "next/navigation";

export default function Layout() {
  if (!DEPLOYMENT_FEATURES.staking) notFound();
  return <StakeScreen />;
}
