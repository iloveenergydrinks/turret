"use client";
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { usePublicClient } from "wagmi";
import { formatUnits } from "viem";
import { queuedPoolRateRead } from "../../pool-lender-rate";
import { rewardsForPool } from "./client";
import { campaignStatus, readCampaignSummary } from "./campaign-summary";
import "./directory-rewards.css";

const date = (seconds: bigint) => new Date(Number(seconds) * 1000).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });

export function PoolRewardsSummary({ pool }: { pool: string }) {
  const deployment = rewardsForPool(pool);
  const client = usePublicClient({ chainId: 4663 });
  const [clock, setClock] = useState(Date.now);
  const query = useQuery({
    queryKey: ["pool-rewards-summary", pool, deployment?.address, deployment?.runtimeHash],
    queryFn: () => queuedPoolRateRead(() => readCampaignSummary(client!, deployment!)),
    enabled: Boolean(deployment && client), staleTime: 30000, refetchInterval: 60000, retry: false,
  });
  useEffect(() => {
    if (!query.data) return;
    const boundaries = [query.data.expiresAt, Number(query.data.start) * 1000, Number(query.data.end) * 1000];
    const next = Math.min(...boundaries.filter(time => time > Date.now()));
    if (!Number.isFinite(next)) return;
    const timer = setTimeout(() => setClock(Date.now()), next - Date.now() + 1);
    return () => clearTimeout(timer);
  }, [query.data, clock]);
  if (!deployment) return <div className="turret-pool-rewards"><p className="turret-reward-status">No TURRET campaign</p></div>;
  const now = Math.max(clock, Date.now());
  const data = !query.isError && query.data && query.data.expiresAt > now ? query.data : null;
  if (!data) return <div className="turret-pool-rewards"><p className="turret-reward-status">{query.isPending && client ? "Checking TURRET rewards…" : "TURRET rewards unavailable"}</p>
    {!query.isPending && <button className="portfolio-text-button" onClick={() => void query.refetch()}>Retry rewards</button>}</div>;
  const status = campaignStatus(data, now);
  const labels = { active: "TURRET rewards active", scheduled: "TURRET rewards scheduled", ended: "TURRET campaign ended", stopped: "TURRET campaign stopped", unfunded: "TURRET rewards not funded" };
  const accruing = status === "active" || status === "scheduled";
  return <div className="turret-pool-rewards">
    <p className="turret-reward-status" data-active={status === "active" || undefined}>{labels[status]}</p>
    {accruing && <><p className="turret-reward-amount">~{Number(formatUnits(data.budget * 86400n / (data.end - data.start), 18)).toLocaleString("en-US", { maximumFractionDigits: 0 })} TURRET/day</p>
      <p>Shared by this pool’s stakers · {status === "scheduled" ? `Starts ${date(data.start)}` : `Ends ${date(data.end)}`} (UTC)</p>
      <p>Lend USDG, then activate rewards in the same flow.</p></>}
    {(status === "ended" || status === "stopped") && <p>Existing stakers can still claim and unstake in the pool.</p>}
  </div>;
}
