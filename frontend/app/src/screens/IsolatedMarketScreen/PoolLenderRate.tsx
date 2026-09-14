"use client";
import { TermLabel } from "../../comps/FieldInfo/FieldInfo";
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { usePublicClient } from "wagmi";
import type { IsolatedMarket } from "@/src/isolated-market-config";
import { formatRateBps, queuedPoolRateRead, readPoolLenderRate } from "@/src/pool-lender-rate";

export function PoolLenderRate({ market }: { market: IsolatedMarket }) {
  const client = usePublicClient({ chainId: 4663 });
  const [clock, setClock] = useState(Date.now);
  const query = useQuery({
    queryKey: ["pool-lender-rate", market.chainId, market.engine, market.pool, market.hashes?.pool],
    queryFn: () => queuedPoolRateRead(() => readPoolLenderRate(client!, market)),
    enabled: Boolean(client), staleTime: 30000, refetchInterval: 60000, retry: false,
  });
  useEffect(() => {
    if (!query.data) return;
    const timer = setTimeout(() => setClock(Date.now()), Math.max(0, query.data.expiresAt - Date.now()));
    return () => clearTimeout(timer);
  }, [query.data]);
  const data = !query.isError && query.data && query.data.expiresAt > Math.max(clock, Date.now()) ? query.data : null;
  const label = query.isPending && client ? "Loading…" : "Unavailable";
  return (
    <div className="dockyard-pool-rate" aria-label={`${market.symbol} lender rate`}>
      <dl>
        <div><dt><TermLabel topic="lenderApr" helpLabel="USDG lending APR">USDG lending APR</TermLabel></dt><dd>{data ? formatRateBps(data.lenderAprBps) : label}</dd></div>
        <div><dt><TermLabel topic="utilization" helpLabel="Pool utilization">Pool utilization</TermLabel></dt><dd>{data ? formatRateBps(data.utilizationBps) : "—"}</dd></div>
      </dl>
      <p>{data
        ? data.principal === 0n ? "No active loans · Borrower APR " + formatRateBps(data.borrowerAprBps)
          : "Borrower APR " + formatRateBps(data.borrowerAprBps) + " · Lender estimate is after protocol fees"
        : query.isPending && client ? "Reading current pool rates" : "Rates could not be refreshed. Try again shortly."}</p>
    </div>
  );
}
