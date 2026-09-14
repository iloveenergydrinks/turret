import { BreakpointName } from "@/src/breakpoints";
import { About } from "@/src/comps/About/About";
import { AppLayout } from "@/src/comps/AppLayout/AppLayout";
import { PreviewAppLayout } from "@/src/comps/AppLayout/PreviewAppLayout";
import { Blocking } from "@/src/comps/Blocking/Blocking";
import { DataSources } from "@/src/comps/DataSources/DataSources";
import { READ_ONLY_DEPLOYMENT } from "@/src/deployment-config";
import { DOCKYARD_STANDALONE_DEPLOYMENT } from "@/src/dockyard-config";
import { Ethereum } from "@/src/services/Ethereum";
import { IndicatorManager } from "@/src/services/IndicatorManager";
import { ReactQuery } from "@/src/services/ReactQuery";
import { StoredState } from "@/src/services/StoredState";
import { TransactionFlow } from "@/src/services/TransactionFlow";
import { UiKit } from "@turret/uikit";
import type { ReactNode } from "react";
import { ISOLATED_MARKETS } from "@/src/isolated-market-config";

// The route group preserves the application's URLs and provider order while
// keeping wallet, RPC and shader dependencies out of the blog's page bundle.
export default function ProtocolLayout({ children }: { children: ReactNode }) {
  return READ_ONLY_DEPLOYMENT
    ? (
      <UiKit>
        <PreviewAppLayout>{children}</PreviewAppLayout>
      </UiKit>
    )
    : DOCKYARD_STANDALONE_DEPLOYMENT || ISOLATED_MARKETS.length
    ? (
      <ReactQuery>
        <UiKit>
          <Ethereum>
            <PreviewAppLayout interactive>{children}</PreviewAppLayout>
          </Ethereum>
        </UiKit>
      </ReactQuery>
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
    );
}
