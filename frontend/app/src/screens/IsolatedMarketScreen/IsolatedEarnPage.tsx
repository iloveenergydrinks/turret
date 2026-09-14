"use client";
import { READ_ONLY_DEPLOYMENT } from "@/src/deployment-config";
import { ISOLATED_MARKETS } from "@/src/isolated-market-config";
import { useSearchParams } from "next/navigation";
import { PoolLenderRate } from "./PoolLenderRate";
import { PoolRewardsSummary } from "../../lending/rewards/PoolRewardsSummary";
import { DeferredMarkets } from "./DeferredMarkets";
import { IsolatedMarketRoute } from "./IsolatedMarketScreen";
import { EarnKnight } from "../../lending/earn-knight/EarnKnight";
export function IsolatedEarnPage() {
  const params = useSearchParams(),
    engines = params.getAll("engine");
  if (engines.length) {
    return (
      <IsolatedMarketRoute
        engine={engines.length === 1 ? engines[0]! : ""}
        mode="earn"
      />
    );
  }
  return (
    <div className="dockyard-isolated dockyard-earn-index">
      <header className="dockyard-earn-index-header">
        <h1>Earn interest by funding isolated loans.</h1>
        <p>
          You are the lender here. Choose a market and deposit USDG from your wallet. Borrowers receive that USDG and deposit their tokens as collateral. You receive pool shares, not the collateral token.
        </p>
        <EarnKnight />
      </header>
      {ISOLATED_MARKETS.length > 0 && !READ_ONLY_DEPLOYMENT && <section className="turret-rewards-intro" aria-labelledby="earn-token-rewards">
        <h2 id="earn-token-rewards">Earn TURRET alongside pool interest</h2>
        <p>20 million TURRET funded across 12 pools for 9–23 September 2026. Follow both steps in the pool: lend USDG, then activate TURRET rewards. The page guides you through the wallet confirmations. Depositing alone does not earn TURRET.</p>
        <p>Each pool’s daily allocation is shared in proportion to the shares staked there. Rewards can accrue even with no active loans. TURRET rewards are separate from USDG interest; their value can fall.</p>
      </section>}
      {ISOLATED_MARKETS.length === 0 || READ_ONLY_DEPLOYMENT
        ? (
          <section aria-labelledby="earn-availability">
              <h2 id="earn-availability">Isolated lending is not open yet</h2>
            <p>
              There are no pools accepting public USDG deposits. The existing borrowing vault is owner-funded.
            </p>
            <p>
              Do not send USDG directly to a vault: a token transfer does not create lender shares or withdrawal rights.
            </p>
            <a href="/">View collateral markets</a>
          </section>
        )
        : (
          <ul className="dockyard-isolated-market-list">
            {ISOLATED_MARKETS.map((m) => (
              <li key={m.engine} className="dockyard-pool-with-rate">
                <div>
                  <span className="dockyard-market-ticker">{m.symbol}</span>
                  <strong>{m.symbol} lending pool</strong>
                  <p>Fund USDG loans secured only by {m.symbol}{m.stock ? " Stock Tokens" : ""}.</p>
                  {m.admission === "commissioning" && <small>Viewing only · New deposits are not open yet</small>}
                </div>
                <div className="turret-pool-returns"><PoolLenderRate market={m} /><PoolRewardsSummary pool={m.pool} /></div>
                <a
                  className="dockyard-pool-action"
                  href={`/earn?engine=${m.engine}`}
                >
                  Open pool
                </a>
              </li>
            ))}
          </ul>
        )}
      <section aria-labelledby="earn-mechanics">
        <h2 id="earn-mechanics">What happens after you deposit</h2>
        <dl className="dockyard-isolated-explainer">
          <div>
            <dt>Your pool shares</dt>
            <dd>
              You own shares in the pool. The pool holds available USDG and lends some to borrowers; the displayed share value is not cash already in your wallet. Interest and losses change that value.
            </dd>
          </div>
          <div>
            <dt>Your return</dt>
            <dd>
              Borrowers pay interest to their market. After the protocol fee, that interest increases the value of the
              market’s pool shares.
            </dd>
          </div>
          <div>
            <dt>Your withdrawal</dt>
            <dd>
              You can withdraw the USDG currently available to your shares. Funds that are out on loan may not be
              immediately available.
            </dd>
          </div>
        </dl>
        <p>
          The displayed lender rate is an estimate, not a guaranteed APY. Liquidation shortfalls can reduce share value.
        </p>
      </section>
      <DeferredMarkets />
    </div>
  );
}
