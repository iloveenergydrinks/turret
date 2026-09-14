import { DEFERRED_MARKETS } from "@/src/deferred-markets";
import { ISOLATED_MARKETS } from "@/src/isolated-market-config";

export function DeferredMarkets() {
  const deferred = DEFERRED_MARKETS.filter(
    (symbol) => !ISOLATED_MARKETS.some((market) => market.symbol === symbol),
  );
  if (deferred.length === 0) return null;
  return (
    <section
      className="dockyard-deferred-markets"
      aria-labelledby="dockyard-deferred-markets-title"
    >
      <div className="dockyard-deferred-markets-heading">
        <h2 id="dockyard-deferred-markets-title">More token markets</h2>
        <span className="dockyard-deferred-status">
          <span aria-hidden="true" />
          Coming soon
        </span>
      </div>
      <ul aria-label="Upcoming token markets">
        {deferred.map((market) => (
          <li key={market}>{market}</li>
        ))}
      </ul>
    </section>
  );
}
