import { useEffect, useRef } from "react";
import type { Loan } from "../../p2p/client";
import { finalDeadline } from "./loanPresentation";

export const DEADLINE_REFRESH_INTERVAL = 30_000;
const MIN_REFRESH_INTERVAL = 5_000;

type Observation = {
  now: number;
  blockNumber?: bigint;
  loans: Loan[];
};
type Options = {
  enabled: boolean;
  paused: boolean;
  observations: Observation[];
  refresh: () => Promise<unknown>;
};

/** Schedule reads from chain time. Elapsed browser time never changes loan status. */
export function useDeadlineRefresh({ enabled, paused, observations, refresh }: Options) {
  const latest = useRef({ paused, refresh });
  latest.current = { paused, refresh };
  const inFlight = useRef(false);
  const onSettled = useRef<(() => void) | null>(null);
  const resumeRequested = useRef(false);
  const lastStarted = useRef<number | null>(null);
  let nextCheck = DEADLINE_REFRESH_INTERVAL;
  const samples = observations.map(({ now, blockNumber, loans }) => {
    let boundary = Infinity;
    for (const loan of loans) {
      const deadlines = loan.status === "open" ? [loan.expiresAt]
        : loan.status === "active" ? [loan.dueAt + 1, finalDeadline(loan) + 1, loan.extensionProposal?.expiresAt]
        : [];
      for (const deadline of deadlines) {
        if (deadline !== undefined && deadline > now) boundary = Math.min(boundary, deadline);
      }
    }
    nextCheck = Math.min(nextCheck, Math.max(MIN_REFRESH_INTERVAL, (boundary - now) * 1000));
    return `${now}:${blockNumber ?? ""}:${boundary}`;
  }).join("|");

  useEffect(() => {
    if (!enabled) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const visible = () => document.visibilityState !== "hidden";
    const clear = () => { clearTimeout(timer); timer = undefined; };
    const schedule = (delay = nextCheck) => {
      clear();
      if (!live || !visible() || latest.current.paused || inFlight.current) return;
      const sinceStart = lastStarted.current === null ? Infinity : performance.now() - lastStarted.current;
      timer = setTimeout(() => { void run(); }, Math.max(delay, MIN_REFRESH_INTERVAL - sinceStart));
    };
    const run = async () => {
      clear();
      if (!live || !visible() || latest.current.paused || inFlight.current) return;
      inFlight.current = true;
      resumeRequested.current = false;
      lastStarted.current = performance.now();
      try { await latest.current.refresh(); }
      catch { /* The data owner reports failures without moving focus. Keep retrying. */ }
      finally {
        inFlight.current = false;
        onSettled.current?.();
      }
    };
    const resume = () => {
      clear();
      if (!visible()) return;
      resumeRequested.current = true;
      schedule(0);
    };
    window.addEventListener("focus", resume);
    document.addEventListener("visibilitychange", resume);
    const settled = () => schedule();
    onSettled.current = settled;
    schedule(resumeRequested.current ? 0 : nextCheck);
    return () => {
      live = false;
      clear();
      if (onSettled.current === settled) onSettled.current = null;
      window.removeEventListener("focus", resume);
      document.removeEventListener("visibilitychange", resume);
    };
  }, [enabled, paused, samples, nextCheck]);
}
