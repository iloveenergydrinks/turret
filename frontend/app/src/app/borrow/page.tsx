import { DOCKYARD_STANDALONE_DEPLOYMENT } from "@/src/dockyard-config";
import { redirect } from "next/navigation";

export default function BorrowPage() {
  if (DOCKYARD_STANDALONE_DEPLOYMENT) redirect("/borrow/aapl");
  return null;
}
