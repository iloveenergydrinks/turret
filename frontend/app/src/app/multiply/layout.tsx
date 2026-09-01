import { DEPLOYMENT_FEATURES } from "@/src/deployment-config";
import { LeverageScreen } from "@/src/screens/LeverageScreen/LeverageScreen";
import { notFound } from "next/navigation";

export default function Page() {
  if (!DEPLOYMENT_FEATURES.leverage) notFound();
  return <LeverageScreen />;
}
