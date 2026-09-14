"use client";
import { useCallback, useEffect, useRef, useState } from 'react';
import manifest from './deployment.json';
import { readCashback, type CashbackResponse, type CashbackConfig } from './client';
import type { CashbackEstimateState } from '../borrow/LoanCostDetails';

type Result = { scope: string; data: CashbackResponse | null; checkedAt: number; error: boolean };
export function useBorrowerCashback(account?: string | null, chainId?: number | null, config: CashbackConfig = manifest) {
  const scope = `${config.deployment?.address}:${chainId}:${account?.toLowerCase()}`;
  const currentScope = useRef(scope);
  currentScope.current = scope;
  const sequence = useRef(0);
  const [result, setResult] = useState<Result | null>(null);
  const [now, setNow] = useState(Date.now);
  const refresh = useCallback(async (signal?: AbortSignal) => {
    if (!config.deployment || !account || chainId !== config.chainId) return;
    const request = ++sequence.current;
    try {
      const data = await readCashback(config, account, signal);
      if (!signal?.aborted && currentScope.current === scope && request === sequence.current)
        setResult({ scope, data, checkedAt: Date.now(), error: false });
    } catch {
      if (!signal?.aborted && currentScope.current === scope && request === sequence.current)
        setResult(previous => ({ scope, data: previous?.scope === scope ? previous.data : null,
          checkedAt: previous?.scope === scope ? previous.checkedAt : 0, error: true }));
    }
  }, [account, chainId, scope, config]);
  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal);
    const timer = setInterval(() => { setNow(Date.now()); void refresh(controller.signal); }, 15000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [refresh]);
  const current = result?.scope === scope ? result : null;
  const fresh = !!current && !current.error && now - current.checkedAt < 30000 && current.data?.fresh === true;
  function estimate(engine: string): CashbackEstimateState {
    if (!config.deployment) return {};
    if (!account || chainId !== config.chainId) return { walletRequired:true };
    const row = current?.data?.accounts.find(row => row.engine.toLowerCase() === engine.toLowerCase());
    return { campaign: current?.data?.campaign, rewardsUnavailable: !fresh,
      enrollment: row && row.committedRebate !== null ? {
        startsAt: row.startsAt, cap: row.cap, committedRebate: current?.data?.publicEnrollment
          ? current.data.accounts.reduce((sum,account)=>sum+(account.committedRebate??account.cap),0n)
          : row.committedRebate,
      } : null };
  }
  return { configured: !!config.deployment, data: current?.data ?? null, fresh,
    error: current?.error ?? false, refresh, estimate };
}
