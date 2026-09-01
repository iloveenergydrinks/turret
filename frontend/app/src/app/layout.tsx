// All global styles should be imported here for easier maintenance
import "@fontsource-variable/figtree";
import "@liquity2/uikit/index.css";
import "./brand.css";

import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";

import { BreakpointName } from "@/src/breakpoints";
import { About } from "@/src/comps/About/About";
import { AppLayout } from "@/src/comps/AppLayout/AppLayout";
import { PreviewAppLayout } from "@/src/comps/AppLayout/PreviewAppLayout";
import { Blocking } from "@/src/comps/Blocking/Blocking";
import { DataSources } from "@/src/comps/DataSources/DataSources";
import content from "@/src/content";
import { READ_ONLY_DEPLOYMENT } from "@/src/deployment-config";
import { Ethereum } from "@/src/services/Ethereum";
import { IndicatorManager } from "@/src/services/IndicatorManager";
import { ReactQuery } from "@/src/services/ReactQuery";
import { StoredState } from "@/src/services/StoredState";
import { TransactionFlow } from "@/src/services/TransactionFlow";
import { UiKit } from "@liquity2/uikit";
import { Analytics } from "@vercel/analytics/react";

export const metadata: Metadata = {
  title: content.appName,
  icons: "/brand/dockyard-safe-harbor-ai.png",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
};

export default function Layout({
  children,
}: {
  children: ReactNode;
}) {
  return (
    <html lang="en">
      <body>
        <template
          data-design-contract="dockyard-gradient-desk-v1-0326060a"
          dangerouslySetInnerHTML={{
            __html: `<!--
THESIS: Dockyard turns ten isolated stock markets into one approachable borrowing desk; it refuses the wide corporate trading terminal and literal nautical theme.
OWN-WORLD: a slow sea-glass mesh gradient, white data surfaces, one deep-teal position composer, blue-green ink, fluid Figtree lettering, quiet depth, and a four-part safe-harbor mark protecting a central berth.
STORY: preview Stock Token to isolated vault to rUSD in the first view, then compare honest max-LTV parameters and choose a market.
FIRST VIEWPORT: compact floating navigation over an asymmetrical promise-and-position desk, a three-move borrowing rail, then one continuous ten-market panel with selectable preview rows.
FORM: safe-harbor control deck, assigned grounded direction 3, evolved from approved composition B, seed 0326060a.
FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, and DESIGN.md
-->`,
          }}
        />
        {READ_ONLY_DEPLOYMENT
          ? (
            <UiKit>
              <PreviewAppLayout>{children}</PreviewAppLayout>
            </UiKit>
          )
          : (
            <ReactQuery>
              <UiKit>
                <StoredState>
                  <DataSources>
                    <BreakpointName>
                      <Ethereum>
                        <IndicatorManager>
                          <Blocking>
                            <TransactionFlow>
                              <About>
                                <AppLayout>
                                  {children}
                                </AppLayout>
                              </About>
                            </TransactionFlow>
                          </Blocking>
                        </IndicatorManager>
                      </Ethereum>
                    </BreakpointName>
                  </DataSources>
                </StoredState>
              </UiKit>
            </ReactQuery>
          )}
        {process.env.NEXT_PUBLIC_VERCEL_ANALYTICS === "true" && <Analytics />}
      </body>
    </html>
  );
}
