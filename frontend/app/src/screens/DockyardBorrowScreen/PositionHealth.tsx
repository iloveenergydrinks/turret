"use client";
import { useEffect, useState } from "react";
import { formatUnits } from "viem";
import { positionHealth } from "../../../../../shared/position-health.mjs";

export function PositionHealth({ collateral, debt, price, liquidationLtvBps, updatedAt, unavailable }: {
  collateral: bigint;
  debt: bigint;
  price?: bigint;
  liquidationLtvBps?: number;
  updatedAt: number;
  unavailable: boolean;
}) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(timer);
  }, []);
  const stale = unavailable || !updatedAt || now - updatedAt > 45000;
  const health = unavailable
    ? { status: "unknown" as const, ltvBps: null, bufferBps: null, liquidationPrice: null }
    : positionHealth({
      collateral,
      debt,
      price: stale ? null : price ?? null,
      liquidationLtvBps: BigInt(liquidationLtvBps ?? 0),
    });
  const labels = {
    "no-debt": "No debt",
    unknown: "Risk data unavailable",
    healthy: "Below warning range",
    warning: "Approaching liquidation",
    critical: "Critically close to liquidation",
    eligible: "Liquidation eligible",
  };
  const percent = (value: bigint | null) => value === null ? "—" : `${(Number(value) / 100).toFixed(2)}%`;
  return (
    <section className="dockyard-health" data-risk={health.status} aria-label="Position health">
      <h3>Position health</h3>
      <p role={health.status === "eligible" || health.status === "critical" ? "alert" : "status"}>
        {labels[health.status]}
      </p>
      <dl className="dockyard-position-values">
        <div>
          <dt>Current LTV</dt>
          <dd>{percent(health.ltvBps)}</dd>
        </div>
        <div>
          <dt>Estimated liquidation price</dt>
          <dd>
            {health.liquidationPrice === null
              ? "—"
              : `$${
                Number(formatUnits(health.liquidationPrice, 18)).toLocaleString(undefined, { maximumFractionDigits: 4 })
              }`}
          </dd>
        </div>
        <div>
          <dt>Price decline to threshold</dt>
          <dd>{percent(health.bufferBps)}</dd>
        </div>
      </dl>
      <p className="dockyard-help">
        {health.status === "unknown"
          ? "The price or position could not be refreshed. Do not assume your loan is safe. Repayment does not require an oracle price."
          : "Warnings start within a 10% price decline of liquidation; critical warnings start within 3%. Price gaps can cross the threshold before any alert arrives."}
      </p>
    </section>
  );
}
