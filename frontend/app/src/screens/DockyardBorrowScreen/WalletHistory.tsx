"use client";

import { DOCKYARD_VAULT_ADDRESS } from "@/src/dockyard-config";
import { formatHistoryAmount, historyStartBlock, loadWalletHistory } from "@/src/dockyard-history";
import { CHAIN_BLOCK_EXPLORER } from "@/src/env";
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { type Address, getAddress, type Hash, isAddress } from "viem";
import { usePublicClient } from "wagmi";

export function WalletHistory({ address, confirmedTransaction }: { address?: Address; confirmedTransaction?: Hash }) {
  const [input, setInput] = useState("");
  const [lookup, setLookup] = useState<Address>();
  const [invalid, setInvalid] = useState(false);
  const wallet = address ?? lookup;
  const client = usePublicClient();
  const queryClient = useQueryClient();
  const vault = DOCKYARD_VAULT_ADDRESS;
  const supported = historyStartBlock(client?.chain.id, vault) !== undefined;
  const queryKey = useMemo(
    () => ["dockyard-wallet-history", client?.chain.id, vault?.toLowerCase(), wallet?.toLowerCase()],
    [
      client?.chain.id,
      vault,
      wallet,
    ],
  );
  const history = useInfiniteQuery({
    queryKey,
    enabled: Boolean(wallet && client && supported),
    initialPageParam: undefined as bigint | undefined,
    queryFn: ({ pageParam, signal }) =>
      loadWalletHistory({
        client: client!,
        wallet: wallet!,
        vault: vault!,
        chainId: client!.chain.id,
        before: pageParam,
        signal,
      }),
    getNextPageParam: (page) => page.before ?? undefined,
    staleTime: 30_000,
    retry: 1,
    refetchOnWindowFocus: false,
  });

  useEffect(() => {
    if (confirmedTransaction && wallet) void queryClient.resetQueries({ queryKey, exact: true });
  }, [confirmedTransaction, queryClient, queryKey, wallet]);

  const entries = history.data?.pages.flatMap((page) => page.entries) ?? [];
  const oldestPage = history.data?.pages.at(-1);
  const explorer = CHAIN_BLOCK_EXPLORER?.url.replace(/\/$/, "");
  const refresh = () => queryClient.resetQueries({ queryKey, exact: true });

  return (
    <section id="wallet-history" className="dockyard-history" aria-labelledby="wallet-history-title">
      <div className="dockyard-panel-title">
        <div>
          <h2 id="wallet-history-title">Wallet history</h2>
          <p>Loans and collateral activity across all Stock Token markets.</p>
        </div>
        {wallet && supported && (
          <button
            className="dockyard-history-control"
            type="button"
            disabled={history.isFetching}
            onClick={() => void refresh()}
          >
            {history.isFetching && !history.isFetchingNextPage ? "Refreshing…" : "Refresh"}
          </button>
        )}
      </div>

      {!address && (
        <form
          className="dockyard-history-lookup"
          onSubmit={(event) => {
            event.preventDefault();
            const valid = isAddress(input.trim());
            setInvalid(!valid);
            if (valid) setLookup(getAddress(input.trim()));
          }}
        >
          <label htmlFor="history-wallet">Connect your wallet above, or look up a wallet address.</label>
          <div>
            <input
              id="history-wallet"
              autoComplete="off"
              spellCheck={false}
              placeholder="0x…"
              value={input}
              onChange={(event) => {
                setInput(event.target.value);
                setInvalid(false);
              }}
              aria-invalid={invalid}
              aria-describedby={invalid ? "history-wallet-error" : undefined}
            />
            <button className="dockyard-history-control" type="submit">View history</button>
          </div>
          {invalid && <p id="history-wallet-error" role="alert">Enter a valid Ethereum wallet address.</p>}
        </form>
      )}

      {wallet && (
        <p className="dockyard-history-wallet">
          {address ? "Connected wallet" : "Viewing wallet"}: <span>{wallet}</span>
        </p>
      )}
      {wallet && !supported && (
        <p className="dockyard-history-state">History is not configured for this vault and network.</p>
      )}
      {wallet && supported && (
        <>
          <div aria-live="polite" role="status">
            {history.isPending && <p className="dockyard-history-state">Reading activity from Robinhood Chain…</p>}
            {history.isError && (
              <p className="dockyard-history-state">
                Couldn’t load {history.isFetchNextPageError ? "older" : "wallet"}{" "}
                activity. Your funds and position are unaffected.{" "}
                <button
                  className="dockyard-history-control"
                  type="button"
                  disabled={history.isFetching}
                  onClick={() => void (history.isFetchNextPageError ? history.fetchNextPage() : history.refetch())}
                >
                  Try again
                </button>
              </p>
            )}
            {!history.isPending && !history.isError && entries.length === 0 && (
              <p className="dockyard-history-state">
                {history.hasNextPage
                  ? "No activity in the blocks checked so far. Load earlier activity to keep looking."
                  : "No Turret loan or collateral activity for this wallet yet."}
              </p>
            )}
          </div>

          {entries.length > 0 && (
            <ol className="dockyard-history-list" aria-label="Confirmed wallet activity">
              {entries.map((entry) => (
                <li key={entry.id} className="dockyard-history-row">
                  <div className="dockyard-history-description">
                    <strong>{entry.title}</strong>
                    <span>{entry.market} market{entry.liquidated ? " · Liquidation" : ""}</span>
                    {entry.timestamp !== null && (
                      <time dateTime={new Date(entry.timestamp * 1000).toISOString()}>
                        {new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(
                          entry.timestamp * 1000,
                        )}
                      </time>
                    )}
                  </div>
                  <dl className="dockyard-history-effects">
                    {entry.effects.map((effect, index) => (
                      <div key={`${effect.label}:${index}`}>
                        <dt>{effect.label}</dt>
                        <dd>{formatHistoryAmount(effect.amount, effect.decimals)} {effect.symbol}</dd>
                      </div>
                    ))}
                  </dl>
                  <div className="dockyard-history-proof">
                    {explorer
                      ? (
                        <a
                          href={`${explorer}/tx/${entry.transactionHash}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          aria-label={`View ${entry.title.toLowerCase()} transaction ${entry.transactionHash} on the block explorer`}
                        >
                          View transaction
                          <svg aria-hidden="true" width="14" height="14" viewBox="0 0 16 16" fill="none">
                            <path
                              d="M5 3h8v8M13 3 3 13"
                              stroke="currentColor"
                              strokeWidth="1.5"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            />
                          </svg>
                        </a>
                      )
                      : <code>{entry.transactionHash.slice(0, 10)}…{entry.transactionHash.slice(-6)}</code>}
                    <span>Block {entry.blockNumber.toLocaleString()}</span>
                  </div>
                </li>
              ))}
            </ol>
          )}

          {oldestPage && (
            <div className="dockyard-history-footer">
              <p>
                {history.hasNextPage
                  ? "Recent activity · earlier blocks not yet checked"
                  : "All activity since vault deployment"}
                <br />
                Blocks{" "}
                {oldestPage.fromBlock.toLocaleString()}–{history.data?.pages[0]?.toBlock.toLocaleString()}. Network fees
                are not included.
              </p>
              {history.hasNextPage && (
                <button
                  className="dockyard-history-control"
                  type="button"
                  disabled={history.isFetching}
                  onClick={() => void history.fetchNextPage()}
                >
                  {history.isFetchingNextPage ? "Loading earlier…" : "Load earlier activity"}
                </button>
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}
