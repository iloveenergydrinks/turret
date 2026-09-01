import { DOCKYARD_STANDALONE_DEPLOYMENT } from "@/src/dockyard-config";
import { DockyardBorrowPage } from "@/src/screens/DockyardBorrowScreen/DockyardBorrowPage";
import { Suspense } from "react";

export default function BorrowPage() {
  if (DOCKYARD_STANDALONE_DEPLOYMENT) {
    return (
      <Suspense>
        <DockyardBorrowPage />
      </Suspense>
    );
  }
  return null;
}
