import { useEffect, useRef, useState } from "react";
import type { Address, Hex } from "viem";
import type { Deployment, Loan, P2PClient, Snapshot } from "./client";

type Market = { config: Deployment; client: P2PClient; own: Snapshot | null };
export type CreditDiscovery = { loans: Loan[]; loading: boolean; complete: boolean; error?: string; more?: boolean };
const empty: CreditDiscovery = { loans: [], loading: false, complete: false };
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** Paginated claim discovery remains separate from loan history and never turns partial results into zero. */
export function useWithdrawalCredits(account: Address | null, markets: readonly Market[]) {
  const [state, setState] = useState<{ account: string | null; entries: Record<string, CreditDiscovery> }>({ account: null, entries: {} });
  const [attempt, setAttempt] = useState(0);
  const [pageBudget, setPageBudget] = useState(20);
  const jobs = useRef(new Map<string, { revision: string; cancelled: boolean }>());
  useEffect(() => () => {
    jobs.current.forEach(job => { job.cancelled = true; });
    jobs.current.clear();
  }, [account]);
  const current = useRef(markets); current.current = markets;
  const signature = markets.filter(m => m.config.version === 3 && m.own).map(m => `${m.config.address}:${m.own!.blockNumber}`).join(";");
  useEffect(() => {
    setState(previous => ({ account, entries: previous.account === account ? previous.entries : {} }));
    if (!account) return;
    for (const market of current.current.filter(m => m.config.version === 3 && m.own && same(m.own.account, account))) {
      const key = market.config.address.toLowerCase();
      const revision = `${market.own!.blockNumber}:${attempt}:${pageBudget}`;
      const previousJob = jobs.current.get(key);
      if (previousJob?.revision === revision) continue;
      if (previousJob) previousJob.cancelled = true;
      const job = { revision, cancelled: false };
      jobs.current.set(key, job);
      const update = (key: string, entry: CreditDiscovery) => {
        if (!job.cancelled) setState(previous => {
          const entries = previous.account === account ? previous.entries : {};
          const retained = !entry.complete ? entries[key]?.loans ?? [] : [];
          const loans = [...new Map([...retained, ...entry.loans].map(loan => [loan.id.toString(), loan])).values()];
          return { account, entries: { ...entries, [key]: { ...entry, loans } } };
        });
      };
      void (async () => {
        const found = new Map<string, Loan>();
        let cursor = 0n, anchor: { number: bigint; hash: Hex } | undefined;
        update(key, { ...empty, loading: true });
        try {
          for (let page = 0; page < pageBudget; page++) {
            const result = await withDeadline(market.client.creditPage(cursor, anchor));
            if (job.cancelled) return;
            anchor = result.anchor;
            result.loans.forEach(loan => found.set(loan.id.toString(), loan));
            const nominal = { USDG: 0n, COLLATERAL: 0n };
            let unavailable = false;
            for (const loan of found.values()) for (const token of ["USDG", "COLLATERAL"] as const) {
              const credit = loan.loanCredits?.[token];
              if (credit?.unavailable) { unavailable = true; continue; }
              if (credit && same(credit.beneficiary, account)) nominal[token] += credit.nominal;
            }
            const complete = !unavailable && nominal.USDG === result.nominal.USDG && nominal.COLLATERAL === result.nominal.COLLATERAL;
            const finished = result.nextCursor === null;
            if (!complete && finished && !unavailable) throw new Error("Credit totals could not be reconciled. Refresh to check all outstanding claims.");
            const more = !complete && !finished && page + 1 === pageBudget;
            update(key, { loans: [...found.values()], loading: !complete && !more && !finished, complete, more,
              ...(unavailable ? { error: "A credit balance could not be read. Healthy credits remain available; the total is incomplete. Refresh to retry unavailable balances." } : {}) });
            if (complete || more || finished) return;
            cursor = result.nextCursor!;
          }
        } catch (cause) {
          update(key, { loans: [...found.values()], loading: false, complete: false, error: cause instanceof Error ? cause.message : "Unable to discover withdrawal credits." });
        }
      })();
    }
  }, [account, signature, attempt, pageBudget]);
  return {
    entries: state.account === account ? state.entries : {},
    retry: () => setAttempt(value => value + 1),
    loadMore: () => setPageBudget(value => value + 20),
  };
}

/** A stalled RPC must become a retryable error instead of an endless spinner. */
async function withDeadline<T>(request: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      request,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("This balance check timed out. Retry to check the missing funds.")), 30_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
