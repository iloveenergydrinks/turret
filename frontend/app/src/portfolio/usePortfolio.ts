import { useEffect, useRef, useState } from "react";
import type { Address } from "viem";
import { friendlyReadError, sameAccount } from "./model";
import type { MarketLoad, PortfolioSource, PortfolioState } from "./model";

const initial = (account: Address | null, sources: readonly PortfolioSource[]): PortfolioState => ({
  account,
  sources: account ? sources.map(({ id, label }) => ({ id, label, phase: "loading" })) : [],
  markets: [],
});

/** Publish each ready market independently; a late read never crosses wallet sessions. */
export function usePortfolio(account: Address | null, sources: readonly PortfolioSource[]) {
  const [state, setState] = useState<PortfolioState>(() => initial(account, sources));
  const controls = useRef<
    {
      refreshMarket(id: string): void;
      loadOlder(id: string): void;
      retrySource(id: PortfolioSource["id"]): void;
      refreshAll(): void;
    } | null
  >(null);

  useEffect(() => {
    setState(initial(account, sources));
    if (!account) {
      controls.current = null;
      return;
    }
    const currentAccount = account;
    let active = true;
    let running = 0;
    const queue: Array<{ sourceId: PortfolioSource["id"]; work(): Promise<void> }> = [];
    const runningSources = new Map<PortfolioSource["id"], number>();
    const loads = new Map<string, MarketLoad>();
    const pending = new Set<string>();
    const discovering = new Set<string>();
    const publish = () => {
      if (active) setState((previous) => ({ ...previous, markets: [...loads.values()] }));
    };
    function drain() {
      while (active && running < 12 && queue.length) {
        // Leave room for the other product so slow pooled reads cannot occupy
        // every slot before its P2P registry has finished loading.
        const index = queue.findIndex((task) => (runningSources.get(task.sourceId) ?? 0) < 8);
        if (index < 0) return;
        const { work, sourceId } = queue.splice(index, 1)[0]!;
        running++;
        runningSources.set(sourceId, (runningSources.get(sourceId) ?? 0) + 1);
        void work().finally(() => {
          running--;
          runningSources.set(sourceId, runningSources.get(sourceId)! - 1);
          drain();
        });
      }
    }
    function enqueue(id: string, older = false) {
      const entry = loads.get(id);
      if (!active || !entry || pending.has(id)) return;
      const cursor = older && (entry.data?.kind === "p2p" || entry.data?.kind === "nft") ? entry.data.nextCursor : undefined;
      if (older && (!cursor || (entry.market.kind !== "p2p" && entry.market.kind !== "nft"))) return;
      pending.add(id);
      loads.set(id, {
        ...entry,
        phase: entry.data ? older ? entry.phase : "ready" : "loading",
        error: undefined,
        refreshing: !older && !!entry.data,
        loadingOlder: older,
        olderError: undefined,
      });
      publish();
      queue.push({
        sourceId: entry.sourceId,
        work: async () => {
          try {
            const data = await entry.market.read(currentAccount, cursor ?? undefined);
            if (!active) return;
            if (!sameAccount(data.account, currentAccount) || data.kind !== entry.market.kind) {
              throw new Error("The wallet changed while loading. Refresh this market.");
            }
            let merged = data;
            const previous = loads.get(id);
            if (older && data.kind === "nft" && previous?.data?.kind === "nft") {
              if (data.nextCursor !== null && cursor !== undefined && cursor !== null && data.nextCursor <= cursor) throw Error("More NFT loans could not be loaded. Retry.");
              const offers = new Map(previous.data.offers.map(loan => [String(loan.id), loan]));
              for (const loan of data.offers) offers.set(String(loan.id), loan);
              merged = { ...data, offers: [...offers.values()] };
            }
            if (older && data.kind === "p2p" && previous?.data?.kind === "p2p") {
              if (data.nextCursor !== null && cursor !== undefined && cursor !== null && data.nextCursor >= cursor) {
                throw new Error("Older loans could not be loaded. Try again.");
              }
              const offers = new Map(previous.data.offers.map((loan) => [loan.id.toString(), loan]));
              for (const loan of data.offers) offers.set(loan.id.toString(), loan);
              merged = { ...data, offers: [...offers.values()] };
            }
            if (!older && data.kind === "p2p" && data.activeLoansComplete === false && previous?.data?.kind === "p2p") {
              const offers = new Map(previous.data.offers.filter(loan => loan.status === "active").map(loan => [loan.id.toString(), loan]));
              for (const loan of data.offers) offers.set(loan.id.toString(), loan);
              merged = { ...data, offers: [...offers.values()] };
            }
            loads.set(id, {
              sourceId: entry.sourceId,
              market: entry.market,
              phase: "ready",
              data: merged,
              refreshing: false,
              loadingOlder: false,
            });
          } catch (error) {
            if (!active) return;
            const previous = loads.get(id)!;
            loads.set(id, {
              ...previous,
              phase: older ? previous.phase : "error",
              refreshing: false,
              loadingOlder: false,
              ...(older ? { olderError: friendlyReadError(error) } : { error: friendlyReadError(error) }),
            });
          } finally {
            pending.delete(id);
            publish();
          }
        },
      });
      drain();
    }
    async function discover(source: PortfolioSource) {
      if (!active || discovering.has(source.id)) return;
      discovering.add(source.id);
      setState((previous) => ({
        ...previous,
        sources: previous.sources.map((entry) =>
          entry.id === source.id
            ? { id: source.id, label: source.label, phase: "loading" }
            : entry
        ),
      }));
      try {
        const markets = await source.discover();
        if (!active) return;
        const ids = new Set<string>();
        for (const market of markets) {
          if (ids.has(market.id) || (loads.has(market.id) && loads.get(market.id)?.sourceId !== source.id)) {
            throw new Error("Market configuration contains duplicate entries. Try again.");
          }
          ids.add(market.id);
        }
        for (const market of markets) {
          if (!loads.has(market.id)) {
            loads.set(market.id, {
              sourceId: source.id,
              market,
              phase: "loading",
              refreshing: false,
              loadingOlder: false,
            });
          }
        }
        setState((previous) => ({
          ...previous,
          sources: previous.sources.map((entry) =>
            entry.id === source.id
              ? { id: source.id, label: source.label, phase: "ready" }
              : entry
          ),
        }));
        publish();
        for (const market of markets) enqueue(market.id);
      } catch (error) {
        if (active) {
          setState((previous) => ({
            ...previous,
            sources: previous.sources.map((entry) =>
              entry.id === source.id
                ? { ...entry, phase: "error", error: friendlyReadError(error) }
                : entry
            ),
          }));
        }
      } finally {
        discovering.delete(source.id);
      }
    }
    controls.current = {
      refreshMarket: (id) => enqueue(id),
      loadOlder: (id) => enqueue(id, true),
      retrySource: (id) => {
        const source = sources.find((source) => source.id === id);
        if (source) void discover(source);
      },
      refreshAll: () => {
        for (const source of sources) {
          if (![...loads.values()].some((entry) => entry.sourceId === source.id)) void discover(source);
        }
        for (const id of loads.keys()) enqueue(id);
      },
    };
    for (const source of sources) void discover(source);
    return () => {
      active = false;
      controls.current = null;
      queue.length = 0;
    };
  }, [account, sources]);

  const visible = state.account && account && sameAccount(state.account, account) ? state : initial(account, sources);
  return {
    ...visible,
    refreshMarket: (id: string) => controls.current?.refreshMarket(id),
    loadOlder: (id: string) => controls.current?.loadOlder(id),
    retrySource: (id: PortfolioSource["id"]) => controls.current?.retrySource(id),
    refreshAll: () => controls.current?.refreshAll(),
  };
}
