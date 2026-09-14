import { EmptyState } from "../../comps/EmptyState/EmptyState";
import { useEffect, useRef, useState } from "react";
import type { Address, EIP1193Provider, Hex } from "viem";
import type { Deployment, TransactionStage } from "../../p2p/client";
import { P2PClient } from "../../p2p/client";
import {
  checkNegotiationWallet,
  type Negotiation,
  type NegotiationAction,
  type NegotiationEvent,
  negotiationReference,
  type NegotiationSession,
  type NegotiationSource,
  readNegotiations,
  signNegotiation,
} from "../../p2p/negotiations";
import type { Offer } from "./loanPresentation";
import { displayDate, loanAmount, sameAddress, shortAddress } from "./loanPresentation";
import { NegotiationEditor, NegotiationTerms } from "./NegotiationTerms";
import "./negotiations.css";

type Props = {
  markets: Deployment[];
  account: Address | null;
  provider: EIP1193Provider | null;
  sourceOffer?: Offer | null;
  disabled?: boolean;
  onBusyChange?: (busy: boolean) => void;
  onConnect: () => void;
  onOpen: (market: Deployment, id: bigint) => void;
};
const message = (e: unknown) =>
  e instanceof Error ? e.message : "Could not complete this action. Refresh before retrying.";
const offerLink = (row: Negotiation, id = row.offerId) =>
  `/borrow/p2p?market=${encodeURIComponent(row.market)}&offer=${id}`;
const journalKey = (row: Negotiation, account: Address) =>
  `turret:negotiation:${row.chainId}:${row.market}:${account}:${row.id}`.toLowerCase();
type Journal = {
  seenRevision?: number;
  attempt?: string;
  ready?: boolean;
  cancelHash?: Hex;
  fundHash?: Hex;
  pendingHash?: Hex;
};
function journal(row: Negotiation, account: Address): Journal {
  try {
    return JSON.parse(localStorage.getItem(journalKey(row, account)) ?? "{}");
  } catch {
    throw new Error("Recovery storage is unavailable. Enable browser storage before continuing.");
  }
}
function unread(row: Negotiation, account: Address) {
  try {
    return row.revision > (journal(row, account).seenRevision ?? 0);
  } catch {
    return false;
  }
}
function save(row: Negotiation, account: Address, value: Journal) {
  localStorage.setItem(journalKey(row, account), JSON.stringify(value));
  if (!localStorage.getItem(journalKey(row, account))) {
    throw new Error("Recovery could not be saved. Do not continue in this browser.");
  }
}
const rejected = (error: unknown): boolean =>
  !!error && typeof error === "object"
  && (("code" in error && error.code === 4001) || ("cause" in error && rejected(error.cause)));
export function Negotiations(
  { markets, account, provider, sourceOffer, disabled = false, onBusyChange, onConnect, onOpen }: Props,
) {
  const current = markets.filter((m) => m.version === 3 && !m.legacy);
  const [session, setSession] = useState<NegotiationSession | null>(null);
  const [rows, setRows] = useState<Negotiation[]>([]);
  const [selected, setSelected] = useState<Negotiation | null>(null);
  const [source, setSource] = useState<NegotiationSource | null>(null);
  const [events, setEvents] = useState<NegotiationEvent[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [eventCursor, setEventCursor] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [working, setWorking] = useState(false);
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState(false);
  const [hash, setHash] = useState("");
  const [risk, setRisk] = useState(false);
  const [stage, setStage] = useState<TransactionStage | null>(null);
  const [clock, setClock] = useState(Date.now());
  const guard = useRef(false), identity = useRef(account), mounted = useRef(true);
  identity.current = account;
  useEffect(() => {
    mounted.current = true;
    identity.current = account;
    return () => {
      mounted.current = false;
      identity.current = null;
    };
  }, []);
  const busy = disabled || working;
  const validSession = session && account && sameAddress(session.account, account) && session.until > clock / 1000
    ? session
    : null;
  const market = current.find((m) =>
    sameAddress(m.address, selected?.market ?? source?.market ?? sourceOffer?.market.address ?? "")
  );
  const [saved, setSaved] = useState<Journal>({});
  const activeId = useRef<string | null>(null);
  useEffect(() => {
    onBusyChange?.(working);
    return () => onBusyChange?.(false);
  }, [working, onBusyChange]);
  useEffect(() => {
    activeId.current = null;
    setSession(null);
    setRows([]);
    setSelected(null);
    setSource(null);
    setEvents([]);
    setError("");
    setNotice("");
    setHash("");
    setRisk(false);
  }, [account, provider]);
  useEffect(() => {
    const timer = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    setRisk(false);
    setEditing(false);
    setHash("");
    try {
      setSaved(selected && account ? journal(selected, account) : {});
    } catch (e) {
      setError(message(e));
    }
  }, [selected?.id, selected?.revision, account]);
  async function refresh(s = validSession, older = false) {
    if (!s) return;
    const who = account;
    setLoading(true);
    try {
      const data = await readNegotiations(s, older && cursor ? { cursor } : {});
      if (identity.current !== who) return;
      setRows((before) => older ? [...before, ...data.threads] : data.threads);
      setCursor(data.nextCursor);
      setError("");
    } catch (e) {
      if (identity.current === who) setError(message(e));
    } finally {
      if (identity.current === who) setLoading(false);
    }
  }
  async function open(row: Negotiation, s = validSession, older = false) {
    if (!s) return;
    const who = account;
    const id = row.id;
    activeId.current = id;
    const data = await readNegotiations(s, { id, ...(older && eventCursor ? { cursor: eventCursor } : {}) });
    if (identity.current !== who || activeId.current !== id) return;
    try {
      if (who) save(data.thread, who, { ...journal(data.thread, who), seenRevision: data.thread.revision });
    } catch { /* Reading private history does not require local storage. */ }
    setSelected(data.thread);
    setSource(null);
    setEvents((before) => older ? [...before, ...data.events] : data.events);
    setEventCursor(data.nextCursor);
    const url = new URL(window.location.href);
    url.searchParams.set("negotiation", id);
    window.history.replaceState(null, "", url);
  }
  useEffect(() => {
    if (!validSession) return;
    const s = validSession;
    const timer = setInterval(() => {
      if (document.visibilityState === "visible" && !guard.current) {
        void refresh(s);
        if (selected) void open(selected, s).catch((e) => setError(message(e)));
      }
    }, 15000);
    return () => clearInterval(timer);
  }, [validSession?.token, selected?.id]);
  async function execute(run: () => Promise<void>) {
    if (guard.current || busy) return;
    guard.current = true;
    setWorking(true);
    setError("");
    setNotice("");
    try {
      await run();
    } catch (e) {
      if (mounted.current) setError(message(e));
    } finally {
      guard.current = false;
      if (mounted.current) setWorking(false);
    }
  }
  async function action(a: NegotiationAction, m = market) {
    if (!account || !provider || !m || identity.current !== account) {
      throw new Error("Connect the participant wallet first.");
    }
    const who = account;
    const result = await signNegotiation(provider, account, m, a);
    if (identity.current !== who) throw new Error("Wallet changed. Unlock the appropriate conversation again.");
    if (result.thread) {
      setSelected(result.thread);
      setSource(null);
      setEditing(false);
      await refresh();
    }
    return result.thread;
  }
  async function unlock() {
    if (!account || !provider || !current[0]) return;
    const who = account;
    const result = await signNegotiation(provider, account, current[0], { action: "login" });
    if (identity.current !== who) return;
    setSession(result);
    await refresh(result);
    const id = new URLSearchParams(window.location.search).get("negotiation");
    if (id && !sourceOffer) {
      const data = await readNegotiations(result, { id });
      if (identity.current !== who) return;
      setSelected(data.thread);
      setEvents(data.events);
      setEventCursor(data.nextCursor);
    }
    if (sourceOffer) {
      const data = await readNegotiations(result, {
        market: sourceOffer.market.address,
        chainId: String(sourceOffer.market.chainId),
        offerId: sourceOffer.loan.id.toString(),
      });
      if (identity.current !== who) return;
      setSource(data.source);
      setSelected(null);
    }
  }
  async function chainStep(kind: "cancel" | "withdraw" | "fund") {
    if (!selected || !account || !provider || !market || !validSession) return;
    const who = account, row = selected, s = validSession, config = market;
    if (!navigator.locks) {
      throw new Error("This browser cannot coordinate wallet actions across tabs. Use a current browser.");
    }
    await navigator.locks.request(journalKey(row, who), { ifAvailable: true }, async (lock) => {
      if (!lock) throw new Error("This replacement is already open in another wallet action. Wait for it to finish.");
      await checkNegotiationWallet(provider, who, config);
      const client = new P2PClient(config);
      await client.connect(provider);
      await checkNegotiationWallet(provider, who, config);
      let j = journal(row, who);
      save(row, who, j);
      let finalSignatureRequested = false;
      const progress = (next: TransactionStage) => {
        if (next.status === "signature" && next.message === "Review and confirm the loan transaction in your wallet.") {
          finalSignatureRequested = true;
        }
        if (identity.current === who) setStage(next);
        if (next.hash) {
          j = { ...j, pendingHash: next.hash };
          if (next.status === "confirmed" && next.message === "Loan transaction confirmed.") {
            j = { ...j, [kind === "cancel" ? "cancelHash" : kind === "fund" ? "fundHash" : "pendingHash"]: next.hash };
          }
          save(row, who, j);
        }
      };
      if (kind === "cancel") {
        const loan = await client.getLoan(BigInt(row.offerId));
        if (loan.status !== "open") {
          throw new Error(
            "Original offer is no longer open. If you already cancelled it, verify its transaction below.",
          );
        }
        const tx = await client.cancel(provider, loan.id, progress);
        j = { ...j, cancelHash: tx };
        save(row, who, j);
        setSaved(j);
        await action({ action: "cancelled", ...negotiationReference(row), hash: tx }, config);
      } else if (kind === "withdraw") {
        const loan = await client.getLoan(BigInt(row.offerId));
        const credit = loan.loanCredits?.USDG;
        if (
          !credit || credit.unavailable || !sameAddress(credit.beneficiary, who) || credit.available < credit.nominal
        ) {
          throw new Error(
            "The original credit is unavailable or has a shortfall. Open the original offer to inspect recovery; no shortfall is written off here.",
          );
        }
        if (credit.nominal === 0n) {
          setNotice("Original USDG is already withdrawn. You can fund the replacement.");
          return;
        }
        await client.withdrawCredit(provider, loan.id, "USDG", credit.nominal, who, progress);
        setNotice("Original USDG withdrawn to your wallet. Review the agreed repayment and fund the replacement next.");
      } else {
        let funding = row;
        if (row.state === "recovering") {
          funding = await action({ action: "prepare", ...negotiationReference(row) }, config);
          j = { ...j, attempt: funding.attempt, ready: true };
          save(row, who, j);
        }
        if (j.attempt !== funding.attempt || !j.ready) {
          throw new Error(
            "A funding attempt is already recorded. Verify its transaction below before any new funding.",
          );
        }
        j = { ...j, ready: false };
        save(row, who, j);
        setSaved(j);
        const t = funding.latest.terms;
        try {
          const tx = await client.createOffer(
            provider,
            {
              borrower: funding.borrower,
              principal: BigInt(t.principal),
              collateral: BigInt(t.collateral),
              interest: BigInt(t.interest),
              durationDays: t.durationDays,
              expiresAt: t.expiresAt,
            },
            progress,
            async () => {
              await readNegotiations(s, { id: funding.id, attempt: funding.attempt! });
              await checkNegotiationWallet(provider, who, config);
            },
          );
          j = { ...j, fundHash: tx };
          save(row, who, j);
          setSaved(j);
          await action({ action: "bind", ...negotiationReference(funding), hash: tx }, config);
          setNotice("Replacement funded and linked. The borrower can now review and accept it.");
        } catch (e) {
          if (
            rejected(e) || !finalSignatureRequested
            || message(e) === "Loan transaction reverted. No contract changes from that transaction were applied."
          ) {
            j = { ...j, ready: true };
            save(row, who, j);
            setSaved(j);
          }
          throw e;
        }
      }
    });
  }
  const lender = selected && account && sameAddress(selected.lender, account);
  const canRespond = selected?.state === "open" && selected.latest.responseBy > clock / 1000;
  const status = (row: Negotiation) =>
    row.state === "open"
      ? (row.latest.responseBy <= clock / 1000
        ? "Proposal expired"
        : sameAddress(row.latest.author, account ?? "")
        ? "Waiting for a response"
        : "Your turn")
      : ({
        agreed: "Terms agreed",
        replacing: "Cancel original offer",
        recovering: "Recover USDG",
        funding: "Finish funding",
        funded: "Replacement funded",
        closed: "Closed",
      }[row.state]);
  return (
    <section className="p2p-negotiations" aria-label="Negotiations">
      <div className="p2p-browser-heading">
        <div className="p2p-section-heading">
          <h2>Negotiate loan terms</h2>
          <p>
            Agree on an amount, repayment and deadline. The lender then funds a new offer for the borrower to accept.
          </p>
        </div>
        {validSession && (
          <button
            className="p2p-reset"
            disabled={busy || loading}
            onClick={() => void execute(() => refresh())}
          >
            Refresh conversations
          </button>
        )}
      </div>
      {!account
        ? (
          <EmptyState title="Your loan conversations" description="Connect your wallet to propose terms and read replies from the other person." actions={<button className="p2p-button" onClick={onConnect}>Connect wallet</button>} />
        )
        : !validSession
        ? (
          <div className="p2p-empty">
            <p>Sign one message to unlock participant-only conversations. This does not approve spending.</p>
            <button className="p2p-button" disabled={busy} onClick={() => void execute(unlock)}>
              Unlock conversations
            </button>
          </div>
        )
        : (
          <>
            {(source || selected) && (
              <button
                className="p2p-reset p2p-back"
                disabled={busy}
                onClick={() => {
                  activeId.current = null;
                  setSource(null);
                  setSelected(null);
                  setEvents([]);
                  const url = new URL(window.location.href);
                  url.searchParams.delete("negotiation");
                  window.history.replaceState(null, "", url);
                }}
              >
                All conversations
              </button>
            )}
            {source && market && (
              <>
                <h3>Propose terms for {market.collateralSymbol} offer #{source.id}</h3>
                <p className="p2p-help">
                  The original offer stays available until the lender cancels it. A proposal does not reserve its funds.
                </p>
                <NegotiationEditor
                  key={source.id}
                  market={market}
                  original={source.terms}
                  initial={source.terms}
                  sourceExpiry={source.terms.expiresAt}
                  disabled={busy}
                  onSubmit={(terms, responseBy) =>
                    execute(async () => {
                      await action({
                        action: "open",
                        offerId: source.id,
                        sourceDigest: source.digest,
                        terms,
                        responseBy,
                      });
                    })}
                />
              </>
            )}
            {selected && market
              ? (
                <>
                  <div className="p2p-neg-heading">
                    <h3>{market.collateralSymbol} offer #{selected.offerId}</h3>
                    <span role="status">{status(selected)}</span>
                  </div>
                  <p className="p2p-help">
                    Borrower {shortAddress(selected.borrower)} · Lender {shortAddress(selected.lender)} ·{" "}
                    <a href={offerLink(selected)}>Original offer</a>
                  </p>
                  <NegotiationTerms original={selected.original} proposed={selected.latest.terms} market={market} />
                  <p className="p2p-help">
                    Respond by{" "}
                    {displayDate(selected.latest.responseBy)}. No loan is opened by agreeing. Early repayment includes
                    all fixed interest; missing the final deadline gives the lender the collateral.
                  </p>
                  {canRespond && (
                    <div className="p2p-neg-actions">
                      {!sameAddress(selected.latest.author, account!) && (
                        <button
                          className="p2p-button"
                          disabled={busy}
                          onClick={() =>
                            void execute(async () => {
                              await action({ action: "agree", ...negotiationReference(selected) });
                            })}
                        >
                          Agree to these terms
                        </button>
                      )}
                      <button className="p2p-button p2p-secondary" disabled={busy} onClick={() => setEditing(!editing)}>
                        {editing ? "Keep current proposal" : "Propose different terms"}
                      </button>
                    </div>
                  )}
                  {editing && canRespond && (
                    <NegotiationEditor
                      key={selected.latest.id}
                      market={market}
                      original={selected.latest.terms}
                      initial={selected.latest.terms}
                      sourceExpiry={selected.original.expiresAt}
                      disabled={busy}
                      onSubmit={(terms, responseBy) =>
                        execute(async () => {
                          await action({ action: "counter", ...negotiationReference(selected), terms, responseBy });
                        })}
                    />
                  )}
                  {selected.state === "agreed" && (
                    <>
                      <p className="p2p-neg-next">
                        Terms agreed. {lender
                          ? "Replace your original offer to fund this loan."
                          : "The lender must replace the original offer. You will review and accept the new offer separately."}
                      </p>
                      {lender && (
                        <button
                          className="p2p-button"
                          disabled={busy || selected.latest.responseBy <= clock / 1000}
                          onClick={() =>
                            void execute(async () => {
                              await action({ action: "start", ...negotiationReference(selected) });
                            })}
                        >
                          Start replacing offer
                        </button>
                      )}
                    </>
                  )}
                  {["replacing", "recovering", "funding"].includes(selected.state) && (
                    <div className="p2p-neg-replacement">
                      <ol className="p2p-neg-steps">
                        <li aria-current={selected.state === "replacing" ? "step" : undefined}>Cancel original</li>
                        <li aria-current={selected.state === "recovering" ? "step" : undefined}>Withdraw USDG</li>
                        <li aria-current={selected.state === "funding" ? "step" : undefined}>Fund replacement</li>
                        <li>Borrower accepts</li>
                      </ol>
                      {lender
                        ? (
                          <>
                            {selected.state === "replacing" && (
                              <>
                                <p>
                                  Cancel the original offer first. Cancellation makes its USDG available to withdraw; it
                                  does not return it to your wallet.
                                </p>
                                <button
                                  className="p2p-button"
                                  disabled={busy}
                                  onClick={() => void execute(() => chainStep("cancel"))}
                                >
                                  Cancel original offer
                                </button>
                              </>
                            )}
                            {selected.state === "recovering" && (
                              <>
                                <p>
                                  Withdraw the original offer’s USDG to your wallet, then fund the agreed amount of{" "}
                                  {loanAmount(BigInt(selected.latest.terms.principal), market)}.
                                </p>
                                <button
                                  className="p2p-button p2p-secondary"
                                  disabled={busy}
                                  onClick={() => void execute(() => chainStep("withdraw"))}
                                >
                                  Withdraw original USDG
                                </button>
                              </>
                            )}
                            {(selected.state === "recovering" || (selected.state === "funding" && saved.ready)) && (
                              <>
                                <label className="p2p-check">
                                  <input
                                    type="checkbox"
                                    checked={risk}
                                    disabled={busy}
                                    onChange={(e) => setRisk(e.target.checked)}
                                  />
                                  <span>
                                    I will lend{" "}
                                    {loanAmount(BigInt(selected.latest.terms.principal), market)}. Repayment is not
                                    guaranteed; after default I receive collateral that may be worth less.
                                  </span>
                                </label>
                                <button
                                  className="p2p-button"
                                  disabled={busy || !risk}
                                  onClick={() => void execute(() => chainStep("fund"))}
                                >
                                  Fund agreed replacement
                                </button>
                              </>
                            )}
                            {selected.state === "funding" && !saved.ready && (
                              <p>
                                A funding attempt was started. Use the saved transaction or paste its hash below to
                                verify and link it. Do not fund a second offer.
                              </p>
                            )}
                            {["replacing", "funding"].includes(selected.state) && (
                              <section className="p2p-neg-recovery">
                                <h3>Already submitted? Recover this step</h3>
                                <p className="p2p-help">
                                  Use the {selected.state === "replacing" ? "cancellation" : "offer creation"}{" "}
                                  transaction, not a token approval. The server verifies the exact contract, parties,
                                  terms and confirmation.
                                </p>
                                <label>
                                  Transaction hash<input
                                    value={hash || (selected.state === "replacing" ? saved.cancelHash : saved.fundHash)
                                      || ""}
                                    onChange={(e) =>
                                      setHash(e.target.value)}
                                    disabled={busy}
                                    spellCheck={false}
                                  />
                                </label>
                                <button
                                  className="p2p-button p2p-secondary"
                                  disabled={busy
                                    || !/^0x[0-9a-f]{64}$/i.test(
                                      hash || (selected.state === "replacing" ? saved.cancelHash : saved.fundHash)
                                        || "",
                                    )}
                                  onClick={() =>
                                    void execute(async () => {
                                      await action({
                                        action: selected.state === "replacing" ? "cancelled" : "bind",
                                        ...negotiationReference(selected),
                                        hash: (hash || (selected.state === "replacing"
                                          ? saved.cancelHash
                                          : saved.fundHash)) as Hex,
                                      });
                                    })}
                                >
                                  Verify confirmed transaction
                                </button>
                                {saved.pendingHash && (
                                  <p className="p2p-help">Last wallet transaction: {saved.pendingHash}</p>
                                )}
                              </section>
                            )}
                          </>
                        )
                        : (
                          <p>
                            The lender is completing the replacement. Your collateral stays in your wallet until you
                            accept the funded loan.
                          </p>
                        )}
                      <a href={offerLink(selected)}>Open original offer and withdrawal options</a>
                    </div>
                  )}
                  {selected.replacement && (
                    <>
                      <p className="p2p-neg-next">
                        Replacement funded. {lender
                          ? "Only the named borrower can accept it."
                          : "Review the exact terms and accept to deposit collateral and receive USDG."}
                      </p>
                      <button className="p2p-button" onClick={() => onOpen(market, BigInt(selected.replacement!.id))}>
                        Review replacement offer #{selected.replacement.id}
                      </button>
                    </>
                  )}
                  {["open", "agreed"].includes(selected.state) && (
                    <button
                      className="p2p-reset"
                      disabled={busy}
                      onClick={() =>
                        void execute(async () => {
                          await action({ action: "close", ...negotiationReference(selected) });
                        })}
                    >
                      Close conversation
                    </button>
                  )}
                  <details
                    className="p2p-neg-history"
                    onToggle={(e) => {
                      if (e.currentTarget.open) void open(selected).catch((e) => setError(message(e)));
                    }}
                  >
                    <summary>Conversation history</summary>
                    {events.map((event, index) => (
                      <div key={`${event.at}:${index}`}>
                        <p>
                          <strong>{event.envelope.action}</strong> · {shortAddress(event.envelope.account)} ·{" "}
                          {displayDate(event.at)}
                        </p>
                        {event.envelope.terms && (
                          <NegotiationTerms
                            market={market}
                            original={selected.original}
                            proposed={event.envelope.terms}
                          />
                        )}
                      </div>
                    ))}
                    {eventCursor && (
                      <button
                        className="p2p-reset"
                        onClick={() => void execute(() => open(selected, validSession, true))}
                      >
                        Older history
                      </button>
                    )}
                  </details>
                </>
              )
              : !source && (
                <>
                  {loading && !rows.length
                    ? <p role="status">Loading conversations…</p>
                    : !rows.length && !error
                    ? (
                      <EmptyState title="No conversations yet" description="Found an offer that almost fits? Open it and choose “Propose different terms” to discuss the amount, repayment or duration with the lender." actions={<a className="p2p-button" href="/borrow/p2p">Browse lending offers</a>} />
                    )
                    : rows.map((row) => (
                      <button
                        className="p2p-neg-row"
                        key={row.id}
                        disabled={busy}
                        onClick={() => void execute(() => open(row))}
                      >
                        <span>
                          <strong>
                            {current.find((m) => sameAddress(m.address, row.market))?.collateralSymbol ?? "Collateral"}
                            {" "}
                            offer #{row.offerId}
                          </strong>
                          <small>
                            {row.latest.terms.durationDays} days ·{" "}
                            {row.latest.terms.principal && current.find((m) => sameAddress(m.address, row.market))
                              ? loanAmount(
                                BigInt(row.latest.terms.principal),
                                current.find((m) => sameAddress(m.address, row.market))!,
                              )
                              : ""}
                          </small>
                        </span>
                        <span>{status(row)}{account && unread(row, account) && <small>New update</small>}</span>
                      </button>
                    ))}
                  {cursor && (
                    <button
                      className="p2p-reset"
                      disabled={busy || loading}
                      onClick={() => void execute(() => refresh(validSession, true))}
                    >
                      Older conversations
                    </button>
                  )}
                </>
              )}
          </>
        )}
      {working && (
        <p role="status" className="p2p-feedback">
          {stage?.message ?? "Confirm the message in your wallet, then wait for it to save."}
        </p>
      )}
      {notice && <p role="status" className="p2p-feedback">{notice}</p>}
      {error && <p role="alert" className="p2p-feedback p2p-error">{error}</p>}
    </section>
  );
}
