import { BorrowScreen } from "@/src/screens/BorrowScreen/BorrowScreen";
import { READ_ONLY_DEPLOYMENT } from "@/src/deployment-config";
import { redirect } from "next/navigation";

export default function Page() {
  if (READ_ONLY_DEPLOYMENT) {
    redirect("/");
  }

  return <BorrowScreen />;
}
