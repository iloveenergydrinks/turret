// All global styles should be imported here for easier maintenance
import "@liquity2/uikit/index.css";
import "./brand.css";

import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";

import { BreakpointName } from "@/src/breakpoints";
import { About } from "@/src/comps/About/About";
import { AppLayout } from "@/src/comps/AppLayout/AppLayout";
import { Blocking } from "@/src/comps/Blocking/Blocking";
import { DataSources } from "@/src/comps/DataSources/DataSources";
import content from "@/src/content";
import { Ethereum } from "@/src/services/Ethereum";
import { IndicatorManager } from "@/src/services/IndicatorManager";
import { ReactQuery } from "@/src/services/ReactQuery";
import { StoredState } from "@/src/services/StoredState";
import { TransactionFlow } from "@/src/services/TransactionFlow";
import { UiKit } from "@liquity2/uikit";
import { Analytics } from "@vercel/analytics/react";
import { GeistSans } from "geist/font/sans";

export const metadata: Metadata = {
  title: content.appName,
  icons: "/favicon.svg",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
};

export default function Layout({
  children,
}: {
  children: ReactNode;
}) {
  return (
    <html lang="en">
      <body className={GeistSans.className}>
        <template
          data-design-contract="rusd-friendly-narrow-v1-bda2b7b3"
          dangerouslySetInnerHTML={{
            __html: `<!--
THESIS: rUSD turns ten isolated stock markets into one friendly borrowing desk; it refuses the wide corporate trading terminal.
OWN-WORLD: light lavender ground, white rounded surfaces, periwinkle actions, navy type, soft offset depth, and an original looped rUSD mark.
STORY: understand Stock Token to vault to rUSD, compare honest max-LTV parameters, then choose a market and borrow.
FIRST VIEWPORT: a compact floating nav, centered promise and three-step mechanism, followed by one narrow ten-market panel with Borrow actions.
FORM: friendly narrow credit desk, grounded direction 3, seed bda2b7b3.
FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, and DESIGN.md
-->`,
          }}
        />
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
        {process.env.NEXT_PUBLIC_VERCEL_ANALYTICS === "true" && <Analytics />}
      </body>
    </html>
  );
}
