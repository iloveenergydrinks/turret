import type { ReactNode } from "react";

import { PreviewBottomBar } from "./PreviewBottomBar";
import { PreviewTopBar } from "./PreviewTopBar";

export function PreviewAppLayout({ children }: { children: ReactNode }) {
  return (
    <div className="rusd-shell">
      <PreviewTopBar />
      <main className="rusd-frame rusd-main">{children}</main>
      <PreviewBottomBar />
    </div>
  );
}
