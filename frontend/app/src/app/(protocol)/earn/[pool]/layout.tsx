import { getEarnPoolStaticParams } from "@/src/deployment-config";
import { redirect } from "next/navigation";

export function generateStaticParams() {
  return getEarnPoolStaticParams();
}

export default function Layout() {
  // Turret pools use an explicitly admitted engine, never legacy LUSD/BOLD routes.
  redirect("/earn");
}
