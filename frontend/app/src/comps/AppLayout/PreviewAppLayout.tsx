import type { ReactNode } from "react";

import { DockyardGradient } from "./DockyardGradient";
import { PreviewBottomBar } from "./PreviewBottomBar";
import { PreviewTopBar } from "./PreviewTopBar";

export function PreviewAppLayout({ children, interactive = false }: { children: ReactNode; interactive?: boolean }) {
  return (
    <div className="rusd-shell">
      <DockyardGradient />
      <PreviewTopBar interactive={interactive} />
      <main className="rusd-frame rusd-main">{children}</main>
      <PreviewBottomBar interactive={interactive} />
    </div>
  );
}
