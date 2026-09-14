"use client";
import { CollectionDirectory } from "./CollectionDirectory";
import { FieldLabel, TermLabel } from "../comps/FieldInfo/FieldInfo";
import { LoanInterestField, useLoanInterest } from "../comps/LoanInterestField/LoanInterestField";
import { termPercent } from "../comps/LoanInterestField/interest";

import { EmptyState } from "../comps/EmptyState/EmptyState";
import { AccountButton } from "../comps/AppLayout/AccountButton";
import { NFTAlerts } from "./NFTAlerts";
import { useEffect, useId, useRef, useState } from "react";
import { encodeFunctionData, formatUnits, isAddress, parseUnits, type Address } from "viem";
import { P2PAppLayout } from "../p2p/P2PAppLayout";
import { useWalletSession, WalletSessionProvider } from "../wallet/useWalletSession";
import { NFTClient, same, validateNFTConfig, type NFTConfig, type NFTOffer } from "./client";
import { nftLendingAbi } from "./abi";
import { nftErrorText as errorText } from "./errors";
import { BorrowPageHeader } from "../borrow/BorrowPageHeader";
import { listNFTRequests, submitNFTRequest, validateListingTerms, type ListingTerms, type NFTRequest, type NFTProposal } from "./requests";
import "../screens/P2PLoansScreen/p2p.css";
import "./nft.css";

type Asset = { collection: Address; collectionName: string; tokenId: string; name: string; image: string };
type Draft = { kind: "request" | "offer"; asset: Asset; row?: NFTRequest; proposal?: NFTProposal; terms?: ListingTerms };
type Review = { draft: Draft; terms: ListingTerms };
type Tab = "market" | "requests" | "collections" | "assets" | "loans";
const ZERO = "0x0000000000000000000000000000000000000000" as Address;
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const cash = (v: bigint | string) => formatUnits(BigInt(v), 6);
const date = (v: bigint | number) => new Date(Number(v) * 1000).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
const imageURL = (collection: string, tokenId: string) => `/api/p2p/nft/image?${new URLSearchParams({ collection, tokenId })}`;

function Art({ asset }: { asset: Asset }) {
  const [failed, setFailed] = useState(false);
  return <div className="nft-art">{failed ? <span>Artwork unavailable<br />#{asset.tokenId}</span>
    : <img src={imageURL(asset.collection, asset.tokenId)} alt={asset.name} loading="lazy" onError={() => setFailed(true)} />}</div>;
}
function Terms({ terms }: { terms: ListingTerms }) {
  return <dl className="nft-terms">
    <div><dt><TermLabel topic="principal" helpLabel="Borrower receives">Borrower receives</TermLabel></dt><dd>{cash(terms.principal)} USDG</dd></div>
    <div><dt><TermLabel topic="interest" helpLabel="Total interest">Total interest</TermLabel></dt><dd>{cash(terms.interest)} USDG · {termPercent(BigInt(terms.principal), BigInt(terms.interest))} for the full term</dd></div>
    <div><dt><TermLabel topic="repayment" helpLabel="Total owed to lender">Total owed to lender</TermLabel></dt><dd>{cash(BigInt(terms.principal) + BigInt(terms.interest))} USDG</dd></div>
    <div><dt><TermLabel topic="duration" helpLabel="Repay within">Repay within</TermLabel></dt><dd>{terms.durationDays} {terms.durationDays === 1 ? "day" : "days"} + 24h grace</dd></div>
  </dl>;
}

const days = (value: number) => `${value} ${value === 1 ? "day" : "days"}`;
function changedTerms(terms: ListingTerms, requested: ListingTerms) {
  return BigInt(terms.principal) !== BigInt(requested.principal)
    || BigInt(terms.interest) !== BigInt(requested.interest) || terms.durationDays !== requested.durationDays;
}
function RequestTerms({ terms, requested }: { terms: ListingTerms; requested?: ListingTerms }) {
  const original = (changed: boolean, value: string) => requested && changed
    ? <span className="nft-term-original">Requested: {value}</span> : null;
  return <dl className="nft-request-terms">
    <div><dt>Borrower receives</dt><dd>{cash(terms.principal)} USDG
      {requested && original(BigInt(terms.principal) !== BigInt(requested.principal), `${cash(requested.principal)} USDG`)}</dd></div>
    <div><dt>Interest for the full term</dt><dd>{cash(terms.interest)} USDG <span>({termPercent(BigInt(terms.principal), BigInt(terms.interest))})</span>
      {requested && original(BigInt(terms.interest) !== BigInt(requested.interest), `${cash(requested.interest)} USDG`)}</dd></div>
    <div><dt>Total repayment</dt><dd>{cash(BigInt(terms.principal) + BigInt(terms.interest))} USDG
      {requested && original(BigInt(terms.principal) + BigInt(terms.interest) !== BigInt(requested.principal) + BigInt(requested.interest), `${cash(BigInt(requested.principal) + BigInt(requested.interest))} USDG`)}</dd></div>
    <div><dt>Repay within</dt><dd>{days(terms.durationDays)}<span> + 24h grace</span>
      {requested && original(terms.durationDays !== requested.durationDays, days(requested.durationDays))}</dd></div>
  </dl>;
}

export function NFTRequestCard({ row, asset, account, busy, now, onLend, onRemove, onOpen, onResume }: {
  row: NFTRequest; asset: Asset; account: Address | null; busy: boolean; now: number;
  onLend: () => void; onRemove: () => void; onOpen: (id: string) => void; onResume: (proposal: NFTProposal) => void;
}) {
  const owner = same(account, row.borrower);
  const current = (row.liveOffers ?? []).filter(o => o.status === "active" || o.status === "open" && o.terms.expiresAt > now);
  const pastOffers = (row.liveOffers ?? []).filter(o => !current.includes(o));
  const proposals = row.proposals.filter(p => !p.cancelled && !row.liveOffers?.some(o => o.id === p.fundedOffer?.id));
  const historyCount = pastOffers.length + proposals.length;
  const offerRow = (o: NonNullable<NFTRequest["liveOffers"]>[number]) => {
    const pending = o.status === "open" && o.terms.expiresAt > now;
    const counteroffer = pending && changedTerms(o.terms, row.terms);
    const label = counteroffer ? "counteroffer" : "offer";
    return <section className="nft-offer-row" key={o.id} aria-label={`Offer #${o.id}`}>
    <div className="nft-offer-row-heading"><div><h3>{pending ? `Lender’s ${label} #${o.id}` : o.status === "active" ? `Active loan #${o.id}` : `Offer #${o.id} · ${o.status === "open" ? "expired" : o.status}`}</h3>
      <p>Lender {short(o.lender)}{same(account, o.lender) ? " · you" : ""}</p></div>
      <button className={`p2p-button${owner && pending ? "" : " p2p-secondary"}`} disabled={busy} onClick={() => onOpen(o.id)}>{pending ? `${owner ? "Review" : "View"} ${label} #${o.id}` : o.status === "active" ? `View loan #${o.id}` : `View offer #${o.id}`}</button></div>
    {pending && <p className="nft-offer-status"><strong>Loan not started.</strong> {owner ? "Waiting for you to accept." : "Waiting for the NFT owner to accept."}</p>}
    {pending && <p className="nft-row-note">{counteroffer ? "The lender changed the requested terms. Changes are marked below." : "The lender matched the requested amount, interest and repayment period."}</p>}
    <RequestTerms terms={o.terms} requested={pending ? row.terms : undefined} />
    <p className="nft-row-note">{pending ? `${cash(o.terms.principal)} USDG is held in the contract. The borrower receives it and the repayment period starts only after accepting. Accept by ${date(o.terms.expiresAt)}.`
      : o.status === "active" ? "Loan started. Open it for the exact repayment deadline."
      : "Acceptance is closed. Open this offer to check its status and withdrawals."}</p>
  </section>;
  };
  return <article className="nft-request nft-request-compact" aria-label={`${asset.name} loan request`}>
    <header className="nft-request-identity"><Art asset={asset} /><div><h2>{asset.name}</h2><p>{owner ? "Your loan request" : `Borrower ${short(row.borrower)}`}</p></div>
      <div className="nft-actions">{account && !owner && <button className={`p2p-button${current.length ? " p2p-secondary" : ""}`} disabled={busy} onClick={onLend}>Offer to lend</button>}
        {owner && <button disabled={busy} onClick={onRemove}>Remove listing only</button>}</div>
    </header>
    <div className="nft-request-body"><h3 className="nft-request-label">{owner ? "What you asked for" : "What the borrower asked for"}</h3><RequestTerms terms={row.terms} />
      <p className="nft-row-note">Request closes {date(row.terms.expiresAt)}.{owner && " Removing it does not cancel deposited offers or active loans."}</p>
      {current.map(offerRow)}
      {historyCount > 0 && <section className="nft-request-history"><h3>Earlier proposals and offers ({historyCount})</h3>
        <p className="nft-row-note">Earlier proposals and closed offers. An unfunded proposal has moved no money.</p>
        {pastOffers.map(offerRow)}
        {proposals.map(p => <section className="nft-offer-row" key={p.id}><h3>Earlier terms from {short(p.lender)}</h3><RequestTerms terms={p.terms} />
          <p className="nft-row-note">{p.fundedOffer ? `On-chain offer #${p.fundedOffer.id}: ${p.fundedOffer.status}. Open it to check withdrawals.` : "These earlier terms moved no money. The lender can review and deposit USDG to make a funded offer."}</p>
          <div className="nft-actions">{same(account, p.lender) && !p.fundedOffer && !row.liveOffers?.some(o => same(o.lender, p.lender) && ["open", "active"].includes(o.status)) && p.terms.expiresAt > now && <button className="p2p-button p2p-secondary" disabled={busy} onClick={() => onResume(p)}>Review and deposit USDG</button>}
            {p.fundedOffer && <button disabled={busy} onClick={() => onOpen(p.fundedOffer!.id)}>Open offer #{p.fundedOffer.id}</button>}</div>
        </section>)}
      </section>}
    </div>
  </article>;
}

function NFTIdentity({ collection, tokenId, manager, borrower, lender }: { collection: Address; tokenId: string; manager: Address; borrower?: Address; lender?: Address }) {
  return <div className="nft-identities"><p>Collection <span>{collection}</span> · Token #{tokenId}</p>
    <a href={`https://robinhoodchain.blockscout.com/token/${collection}?a=${tokenId}`} target="_blank" rel="noreferrer">Verify this NFT on the explorer</a>
    <details><summary>Contract and counterparties</summary><p>Lending contract <span>{manager}</span></p>
      {lender && <p>Lender <span>{lender}</span></p>}
      {borrower && <p>Borrower {same(borrower, ZERO) ? "The current owner of this exact NFT" : <span>{borrower}</span>}</p>}
    </details></div>;
}
function OfferTerms(o: NFTOffer): ListingTerms {
  return { collection: o.terms.collection, tokenId: String(o.terms.tokenId), principal: String(o.terms.principal),
    interest: String(o.terms.interest), durationDays: Number(o.terms.duration / 86400n), expiresAt: Number(o.terms.expiresAt) };
}
function LoanExchange({ borrowing, amount, interest, days, nft }: { borrowing: boolean; amount: string; interest: string; days: string; nft: string }) {
  const valid = /^\d+(\.\d{1,6})?$/.test(amount) && /^\d+(\.\d{1,6})?$/.test(interest);
  const total = valid ? cash(parseUnits(amount, 6) + parseUnits(interest, 6)) : "—";
  return <div className="nft-exchange" aria-label="Who gets what">
    <p><strong>{borrowing ? "You receive" : "You lend"}: {/^\d+(\.\d{1,6})?$/.test(amount) ? amount : "—"} USDG.</strong> {borrowing ? `The contract holds your ${nft} until the loan is settled.` : `The NFT owner receives the money. The contract holds ${nft}, not your wallet.`}</p>
    <p><strong>{borrowing ? "You repay" : "Borrower repays"}: {total} USDG within {days || "—"} {days === "1" ? "day" : "days"}.</strong> {borrowing ? "Then you can withdraw your NFT." : "Then you can withdraw that USDG and the borrower can withdraw their NFT."} The full interest is due even if repaid early.</p>
    <p><strong>If repayment is missed:</strong> after an extra 24 hours, {borrowing ? "the lender can claim your entire NFT" : "you can claim the entire NFT instead of repayment"}. {borrowing ? "You get no refund if the NFT is worth more than the debt." : "The NFT may be worth less than you lent."}</p>
  </div>;
}
export function DraftForm({ draft, busy, onReview, onCancel }: { draft: Draft; busy: boolean; onReview: (terms: ListingTerms) => void; onCancel: () => void }) {
  const fieldId = useId();
  const borrowing = draft.kind === "request";
  const initial = draft.terms ?? draft.row?.terms;
  const [principal, setPrincipal] = useState(initial ? cash(initial.principal) : "");
  const interestModel = useLoanInterest(principal, 6, initial ? cash(initial.interest) : "0");
  const { interest } = interestModel;
  const [days, setDays] = useState(String(initial?.durationDays ?? 30));
  const local = new Date((initial?.expiresAt ?? Math.floor(Date.now() / 1000) + 7 * 86400) * 1000);
  const [expiry, setExpiry] = useState(new Date(local.getTime() - local.getTimezoneOffset() * 60000).toISOString().slice(0, 16));
  const [error, setError] = useState("");
  return <section className="nft-editor" aria-label="NFT loan terms">
    <div className="nft-editor-art"><Art asset={draft.asset} /><h2>{draft.asset.name}</h2><p>{draft.asset.collectionName}</p>
      <a href={`https://robinhoodchain.blockscout.com/token/${draft.asset.collection}?a=${draft.asset.tokenId}`} target="_blank" rel="noreferrer">Verify NFT #{draft.asset.tokenId}</a></div>
    <form onSubmit={event => { event.preventDefault(); try {
      if (!/^\d+(\.\d{1,6})?$/.test(principal) || !/^\d+(\.\d{1,6})?$/.test(interest) || !/^[1-9]\d*$/.test(days)) throw Error("Enter exact USDG amounts and whole days. Total repayment must be at least the amount lent.");
      const expiresAt = draft.proposal?.terms.expiresAt ?? Math.floor(new Date(expiry).getTime() / 1000);
      onReview({ collection: draft.asset.collection, tokenId: draft.asset.tokenId, principal: String(parseUnits(principal, 6)),
        interest: String(parseUnits(interest, 6)), durationDays: Number(days), expiresAt });
    } catch (e) { setError(errorText(e)); } }}>
      <h2>{borrowing ? "Borrow USDG using your NFT" : "Lend USDG to this NFT’s owner"}</h2>
      <p>{borrowing ? "You are the borrower. Choose how much you want and what you will repay." : "You are the lender. Choose how much to lend and what the borrower must repay."}</p>
      <fieldset disabled={busy}><div className="nft-fields">
        <div className="turret-labeled-field"><FieldLabel htmlFor={`${fieldId}-principal`} topic="principal" helpLabel="loan amount">{borrowing ? "USDG you want to borrow" : "USDG you will lend"}</FieldLabel><input id={`${fieldId}-principal`} disabled={!!draft.proposal} value={principal} onChange={e => setPrincipal(e.target.value)} inputMode="decimal" required /></div>
        <div className="turret-labeled-field"><FieldLabel htmlFor={`${fieldId}-days`} topic="duration" helpLabel="days to repay">Days to repay after the loan starts</FieldLabel><input id={`${fieldId}-days`} disabled={!!draft.proposal} value={days} onChange={e => setDays(e.target.value)} inputMode="numeric" required /></div>
        <div className="turret-labeled-field"><FieldLabel htmlFor={`${fieldId}-expiry`} topic="expiry" helpLabel="expiry">{borrowing ? "Keep this request open until" : "Borrower must accept by"} · your local time</FieldLabel><input id={`${fieldId}-expiry`} type="datetime-local" disabled={!!draft.proposal} value={expiry} onChange={e => setExpiry(e.target.value)} required /></div>
      </div><LoanInterestField model={interestModel} duration={days} decimals={6} disabled={busy || !!draft.proposal} /><LoanExchange borrowing={borrowing} amount={principal} interest={interest} days={days} nft={draft.asset.name} />
      <p className="nft-note">{draft.kind === "offer" ? "Next: review and deposit your USDG into the contract. The loan starts only when the NFT owner accepts. Until then, you can cancel and withdraw your USDG." : "Next: review and sign to publish these terms. No NFT or USDG moves yet. The lender must deposit USDG, then the NFT owner must accept to start the loan."}</p>
      {error && <p role="alert">{error}</p>}
      <div className="nft-actions"><button className="p2p-button" type="submit">{borrowing ? "Review what you will repay" : "Review what you will lend"}</button><button className="p2p-button p2p-secondary" type="button" onClick={onCancel}>Cancel</button></div></fieldset>
    </form>
  </section>;
}

export function NFTLoansScreen({ embedded = false, sharedWallet = false }: { embedded?: boolean; sharedWallet?: boolean }) {
  const content = <NFTWorkspace embedded={embedded} />;
  return sharedWallet ? content : <WalletSessionProvider>{content}</WalletSessionProvider>;
}
function NFTWorkspace({ embedded }: { embedded: boolean }) {
  const session = useWalletSession();
  const [config, setConfig] = useState<NFTConfig | null>(null);
  const [client, setClient] = useState<NFTClient | null>(null);
  const [tab, setTab] = useState<Tab>("requests");
  const [collection, setCollection] = useState("");
  const [query, setQuery] = useState("");
  const [assets, setAssets] = useState<Asset[]>([]);
  const [offers, setOffers] = useState<NFTOffer[]>([]);
  const [requests, setRequests] = useState<NFTRequest[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [review, setReview] = useState<Review | null>(null);
  const [selected, setSelected] = useState<NFTOffer | null>(null);
  const [consent, setConsent] = useState(false);
  const [recipient, setRecipient] = useState("");
  const [replacementHash, setReplacementHash] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [recentFunding, setRecentFunding] = useState<{id: string; hash: `0x${string}`} | null>(null);
  const [confirmed, setConfirmed] = useState<{hash: string; label: string; offerId?: string} | null>(null);
  const [detailsStale, setDetailsStale] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [configAttempt, setConfigAttempt] = useState(0);
  const [now, setNow] = useState(Math.floor(Date.now() / 1000));
  const chainClock = useRef<{ seconds: number; received: number } | null>(null);
  const details = useRef<HTMLElement>(null);
  const errorNotice = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (error) {
      errorNotice.current?.focus({ preventScroll: true });
      errorNotice.current?.scrollIntoView({ block: "center" });
    }
  }, [error]);
  const operation = useRef(false), generation = useRef(0);
  const account = session.chainId === config?.chainId && session.provider ? session.account : null;
  const actor = useRef(account); actor.current = account;
  const walletIdentity = `${account}:${session.chainId}`;
  const walletState = useRef({ identity: walletIdentity, epoch: 0 });
  if (walletState.current.identity !== walletIdentity) walletState.current = { identity: walletIdentity, epoch: walletState.current.epoch + 1 };
  const operationWalletEpoch = useRef(-1);
  const canCommit = (a: Address) => same(actor.current, a) && operationWalletEpoch.current === walletState.current.epoch;
  const assetFor = (address: Address, id: string): Asset => {
    const c = config?.collections.find(x => same(x.address, address));
    return { collection: address, collectionName: c?.name ?? short(address), tokenId: id, name: `${c?.name ?? "NFT"} #${id}`, image: imageURL(address, id) };
  };
  useEffect(() => {
    let current = true;
    setLoading(true); setError("");
    fetch("/nft-market.json", { cache: "no-store" }).then(async response => {
      if (!response.ok) throw Error("NFT lending is not available on this deployment yet.");
      const c = validateNFTConfig(await response.json()); const api = new NFTClient(c); await api.verify();
      if (current) { setConfig(c); setClient(api); }
    }).catch(e => { if (current) { setError(errorText(e)); setLoading(false); } });
    return () => { current = false; };
  }, [configAttempt]);
  useEffect(() => {
    setConfirmed(null); setDetailsStale(false); setRecentFunding(null);
    if (client && account) { try { setRecentFunding(client.lastFunding(account)); } catch (e) { setError(errorText(e)); } }
  }, [client, account]);
  useEffect(() => { setDraft(null); setReview(null); setSelected(null); setConsent(false); setRecipient(account ?? ""); setReplacementHash(""); }, [account, session.chainId]);
  useEffect(() => {
    if (!client) return;
    const id = new URLSearchParams(window.location.search).get("offer");
    if (!id) return;
    let current = true;
    if (!/^[1-9][0-9]{0,77}$/.test(id) || BigInt(id) >= 2n ** 256n) { setError("Invalid NFT offer link."); return; }
    client.offer(BigInt(id)).then(offer => {
      if (current) { if (!offer.status) throw Error("This NFT offer does not exist."); setSelected(offer); setConsent(false); }
    }).catch(e => { if (current) setError(errorText(e)); });
    return () => { current = false; };
  }, [client, account]);
  useEffect(() => {
    if (!client) return;
    let current = true;
    const sync = async () => {
      try {
        const block = await client.publicClient.getBlock();
        if (current) { chainClock.current = { seconds: Number(block.timestamp), received: performance.now() }; setNow(Number(block.timestamp)); }
      } catch { /* Transaction admission still verifies current chain state. Keep the last observed clock. */ }
    };
    void sync();
    const refresh = setInterval(() => void sync(), 60_000);
    const tick = setInterval(() => { const clock = chainClock.current; if (clock) setNow(clock.seconds + Math.floor((performance.now() - clock.received) / 1000)); }, 1000);
    return () => { current = false; clearInterval(refresh); clearInterval(tick); };
  }, [client, attempt]);
  useEffect(() => { setConsent(false); }, [selected?.id, selected?.status, selected?.usdgCredit, selected?.nftBeneficiary]);
  useEffect(() => { if (selected) { details.current?.focus({ preventScroll: true }); details.current?.scrollIntoView({ block: "start" }); } }, [selected?.id]);
  useEffect(() => {
    if (!client) return;
    const id = ++generation.current;
    setLoading(true); setError(""); setCursor(null); setOffers([]); setAssets([]); setRequests([]);
    (async () => {
      if (tab === "requests") {
        const page = await listNFTRequests({ market: client.config.address });
        if (id === generation.current) { setRequests(page.requests); setCursor(page.nextCursor); }
      } else if (tab === "collections") {
        // The directory uses verified configuration, not an unrequested NFT catalogue.
        return;
      } else if (tab === "assets") {
        if (!account) return;
        const params = { owner: account, ...(collection ? { collection } : {}) };
        const response = await fetch(`/api/p2p/nft/assets?${new URLSearchParams(params)}`);
        const page = await response.json(); if (!response.ok) throw Error(page.error || "NFTs could not be loaded.");
        if (id === generation.current) { setAssets(page.items); setCursor(page.nextPage); }
      } else {
        if (tab === "loans" && !account) return;
        const page = tab === "loans" ? await client.accountOffers(account!) : await client.latestOffers();
        if (id === generation.current) { setOffers(page.offers); setCursor(page.more ? String(page.nextCursor) : null); }
      }
    })().catch(e => { if (id === generation.current) setError(errorText(e)); }).finally(() => { if (id === generation.current) setLoading(false); });
    return () => { generation.current++; };
  }, [client, tab, account, collection, attempt]);
  async function run(action: (c: NFTClient, a: Address) => Promise<void>, refresh = true) {
    if (!client || !account || !session.provider || operation.current) return;
    operation.current = true; setBusy(true); setError(""); setNotice("Checking loan details…"); const a = account;
    operationWalletEpoch.current = walletState.current.epoch;
    try { await action(client, a); if (canCommit(a)) { setConsent(false); if (refresh) setAttempt(x => x + 1); } }
    catch (e) { if (canCommit(a)) { setNotice(""); setError(errorText(e)); } }
    finally { operation.current = false; setBusy(false); }
  }
  const status = (text: string) => { if (operationWalletEpoch.current === walletState.current.epoch) setNotice(text); };
  const tx = async (c: NFTClient, a: Address, data: `0x${string}`, label = "loan transaction") => {
    const receipt = await c.send(session.provider!, a, c.config.address, data, status, label);
    if (canCommit(a)) { setConfirmed({ hash: receipt.transactionHash, label, offerId: selected ? String(selected.id) : undefined }); setDetailsStale(true); }
    return receipt;
  };
  async function refreshSelected(c: NFTClient, a: Address, id: bigint) {
    try { const offer = await c.offer(id); if (canCommit(a)) { setSelected(offer); setConsent(false); setDetailsStale(false); } }
    catch { throw Error("Transaction confirmed. The updated loan details could not load. Refresh data before the next action."); }
  }
  async function viewOffer(id: bigint) {
    if (!client) return;
    const revision = generation.current;
    try { const offer = await client.offer(id); if (revision === generation.current) { setSelected(offer); setConsent(false); setDetailsStale(false); } }
    catch (e) { if (revision === generation.current) setError(errorText(e)); }
  }
  async function publish() {
    if (!review) return;
    const r = review;
    await run(async (c, a) => {
      const block = await c.verify(); const t = validateListingTerms(r.terms, c, Number(block.timestamp));
      if (r.draft.proposal && (["collection", "tokenId", "principal", "interest", "durationDays", "expiresAt"] as const).some(key => String(r.terms[key]).toLowerCase() !== String(r.draft.proposal!.terms[key]).toLowerCase())) throw Error("Funding must match the exact proposal. Submit a new proposal to change its terms.");
      if (r.draft.kind === "offer") {
        t.borrower = r.draft.row?.borrower ?? ZERO;
        const funded = await c.fundOffer(session.provider!, a, t, status);
        if (!canCommit(a)) return;
        // Close the funding form before any follow-up read can fail.
        setReview(null); setDraft(null); setTab("loans");
        setRecentFunding(c.lastFunding(a));
        setNotice(funded.existing ? `Offer #${funded.id} already exists for this NFT. No additional USDG was deposited.`
          : `USDG deposited for offer #${funded.id}. The NFT owner can now review and accept it.`);
        await refreshSelected(c, a, funded.id);
      } else {
        await submitNFTRequest(c, session.provider!, a, { action: "publish", terms: r.terms });
        if (!canCommit(a)) return;
        setNotice("Your loan request is listed. Your NFT stays in your wallet until you accept a deposited offer.");
        setReview(null); setDraft(null); setTab("requests");
      }
    });
  }
  function begin(d: Draft) { setDetailsStale(false); setNotice(""); setSelected(null); setReview(null); setDraft(d); setConsent(false); setError(""); }
  const filtered = <T extends { terms: { collection: Address; tokenId: bigint | string } }>(rows: T[]) => rows.filter(o =>
    (!collection || same(o.terms.collection, collection)) && (!query || `${assetFor(o.terms.collection, String(o.terms.tokenId)).name}`.toLowerCase().includes(query.toLowerCase())));
  function state(o: NFTOffer) { return o.status === 1 && Number(o.terms.expiresAt) <= now ? "Offer expired" : o.status === 2
    ? now > Number(o.dueAt) + 86400 ? "Default claim available" : now > Number(o.dueAt) ? "In grace period" : "Loan active"
    : ["Unknown", "USDG deposited · waiting for NFT owner", "Loan active", "Repaid", "Defaulted", "Cancelled", "Expired"][o.status]; }
  async function more() {
    if (!client || !cursor || loading) return; setLoading(true);
    const revision = generation.current;
    try {
      if (tab === "requests") { const p = await listNFTRequests({ cursor, market: client.config.address }); if (revision !== generation.current) return; setRequests(x => [...x, ...p.requests]); setCursor(p.nextCursor); }
      else if (tab === "assets" && account) {
        const params = { owner: account, pageKey: cursor, ...(collection ? { collection } : {}) };
        const response = await fetch(`/api/p2p/nft/assets?${new URLSearchParams(params)}`);
        const p = await response.json(); if (!response.ok) throw Error(p.error); if (revision !== generation.current) return; setAssets(x => [...x, ...p.items]); setCursor(p.nextPage); }
      else { const p = tab === "loans" ? await client.accountOffers(account!, BigInt(cursor)) : await client.latestOffers(BigInt(cursor)); if (revision !== generation.current) return; setOffers(x => [...x, ...p.offers]); setCursor(p.more ? String(p.nextCursor) : null); }
    } catch (e) { if (revision === generation.current) setError(errorText(e)); } finally { if (revision === generation.current) setLoading(false); }
  }
  // Refresh public chain state without replacing the user’s draft or moving focus.
  useEffect(() => {
    if (!client || busy || draft || review) return;
    let current = true;
    const update = async () => {
      try {
        const block = await client.verify();
        if (offers.length) { const rows = await client.batch(offers.map(o => o.id), block.number); if (current) setOffers(rows); }
        if (tab === "requests") { const page = await listNFTRequests({ market: client.config.address }); if (current) { setRequests(page.requests); setCursor(page.nextCursor); } }
        if (selected) { const fresh = await client.offer(selected.id); if (current) { setSelected(fresh); setDetailsStale(false); } }
      } catch { if (current) { setDetailsStale(true); setError("Live loan status could not refresh. Refresh data before acting."); } }
    };
    const interval = setInterval(() => void update(), 30_000);
    return () => { current = false; clearInterval(interval); };
  }, [client, tab, busy, draft, review, selected?.id, offers.map(o => o.id).join(","), attempt]);
  useEffect(() => {
    if (!client || !selected || busy) return;
    let current = true;
    client.offer(selected.id).then(o => { if (current) { setSelected(o); setDetailsStale(false); } }).catch(() => { if (current) setDetailsStale(true); });
    return () => { current = false; };
  }, [client, selected?.id, attempt]);
  const visibleAssets = assets.filter(a => !query || a.name.toLowerCase().includes(query.toLowerCase()));
  const visibleRequests = filtered(requests);
  const visibleOffers = filtered(offers).filter(o => tab === "loans" || o.status === 1 && Number(o.terms.expiresAt) > now);
  const validRecipient = isAddress(recipient, { strict: false }) && !same(recipient, ZERO);
  let pending = false;
  try { pending = !!(client && account && client.pending(account)); } catch { pending = true; }
  const showingDetails = !!selected && !draft && !review;
  const canWithdraw = !!selected && (same(account, selected.nftBeneficiary) || same(account, selected.lender) && selected.usdgCredit > 0n);
  const actionFeedback = <>
      {error && <div ref={errorNotice} tabIndex={-1} role="alert" className="nft-message"><p>{error}</p><button type="button" disabled={busy} onClick={() => client ? setAttempt(x => x + 1) : setConfigAttempt(x => x + 1)}>Refresh data</button></div>}
      {notice && <p role="status" className="nft-message">{notice}</p>}
      {pending && <div className="nft-message"><p>A transaction needs verification before another can be submitted.</p>
        <label>Replacement transaction hash · optional<input value={replacementHash} onChange={e => setReplacementHash(e.target.value)} placeholder="0x…" /></label>
        <button disabled={busy} onClick={() => void run(async (c, a) => {
        const replacement = replacementHash.trim(); if (replacement && !/^0x[0-9a-f]{64}$/i.test(replacement)) throw Error("Enter the full replacement transaction hash from your wallet.");
        const result = await c.reconcile(a, replacement ? replacement as `0x${string}` : undefined); if (!canCommit(a)) return; setRecentFunding(c.lastFunding(a)); if (result?.equivalent && result.receipt.status === "success") { setReview(null); setDraft(null); setConfirmed({ hash: result.receipt.transactionHash, label: "recovered transaction" }); } setNotice(!result ? "Still pending. Check your wallet and retry." : result.equivalent && result.receipt.status === "success" ? "Transaction verified. Refresh the offer before continuing." : "The original action reverted or was replaced.");
      })}>Verify transaction</button></div>}
  </>;
  const content = <div className="borrow-hub"><BorrowPageHeader active="nfts" />
    <div className="p2p-page nft-page borrow-selected-content">
      <div className="nft-actions borrow-nft-actions">
        <button className="p2p-button" disabled={!client || busy} onClick={() => { setQuery(""); setCollection(""); setTab("assets"); setDraft(null); setReview(null); setSelected(null); }}>List my NFT</button></div>
      <div className="nft-policy"><span>Full repayment agreed upfront</span><span>24-hour grace period</span><span>No price-triggered liquidation</span></div>
      {session.account && session.chainId !== config?.chainId && config && <p role="alert">Switch your wallet to Robinhood Chain to continue.</p>}
      {!review && !showingDetails && actionFeedback}
      {recentFunding && !review && recentFunding.id !== String(selected?.id) && <div className="nft-message" role="status"><strong>Your recent deposit: offer #{recentFunding.id}</strong><p>Open the offer to check whether it is waiting, active, or closed.</p><div className="nft-actions"><button disabled={busy} onClick={() => void viewOffer(BigInt(recentFunding.id))}>Open offer #{recentFunding.id}</button><a href={`https://robinhoodchain.blockscout.com/tx/${recentFunding.hash}`} target="_blank" rel="noreferrer">View deposit transaction</a></div></div>}
      {confirmed && (!selected || confirmed.offerId !== String(selected.id)) && <div className="nft-message" role="status"><strong>Confirmed: {confirmed.label}.</strong> <a href={`https://robinhoodchain.blockscout.com/tx/${confirmed.hash}`} target="_blank" rel="noreferrer">View transaction</a></div>}


      {draft && !review && <DraftForm key={`${draft.kind}:${draft.asset.collection}:${draft.asset.tokenId}:${draft.proposal?.id ?? ""}`} draft={draft} busy={busy} onCancel={() => setDraft(null)}
        onReview={terms => { if (!client) return; validateListingTerms(terms, client, now); setReview({ draft, terms }); setConsent(false); }} />}
      {review && <section className="nft-review" aria-label="Review NFT loan terms"><h2>Review {review.draft.kind === "request" ? "what you will borrow" : "what you will lend"}</h2>
        <h3>{review.draft.asset.name}</h3><NFTIdentity collection={review.terms.collection} tokenId={review.terms.tokenId} manager={config!.address}
          borrower={review.draft.row?.borrower ?? (review.draft.kind === "request" ? account ?? undefined : ZERO)}
          lender={review.draft.kind === "request" ? undefined : account ?? undefined} /><LoanExchange borrowing={review.draft.kind === "request"} amount={cash(review.terms.principal)} interest={cash(review.terms.interest)} days={String(review.terms.durationDays)} nft={review.draft.asset.name} />
        <p>{review.draft.kind === "request" ? "Request closes" : "Borrower must accept by"} {date(review.terms.expiresAt)}. The repayment period starts when the NFT owner accepts the loan in their wallet.</p>
        <p>{review.draft.kind === "offer" ? `You will deposit ${cash(review.terms.principal)} USDG into the contract now. The NFT owner receives it only when they accept. Until then, you can cancel and withdraw your USDG.` : "Signing publishes these terms. It does not transfer your NFT or USDG, or create a loan."}</p>
        <label className="p2p-check"><input type="checkbox" checked={consent} onChange={e => setConsent(e.target.checked)} />I have checked the exact NFT, repayment and deadlines.</label>
        <div className="nft-review-feedback" aria-live="polite">{actionFeedback}</div>
        <div className="nft-actions"><button type="button" className="p2p-button" aria-busy={busy} disabled={!account || busy || pending || !consent} onClick={() => void publish()}>{busy ? (notice.startsWith("Confirm the") ? "Check your wallet" : notice.startsWith("Transaction submitted") ? "Confirming transaction…" : "Checking loan details…") : review.draft.kind === "offer" ? `Approve and deposit ${cash(review.terms.principal)} USDG` : "Sign and list my request"}</button>
          <button className="p2p-button p2p-secondary" disabled={busy} onClick={() => { setReview(null); setDraft({ ...review.draft, terms: review.terms }); }}>Edit terms</button></div>
        <p className="nft-note">{review.draft.kind === "offer" ? "Wallet steps: approve the exact USDG amount if needed, then confirm the deposit. No message signature is required." : "One gas-free message signature publishes your request. You approve the NFT and accept a deposited offer later, when you choose to borrow."}</p>
      </section>}
      {!draft && !review && <>
        <nav className="nft-tabs" aria-label="NFT lending views">{([["requests", "Loan requests"], ["collections", "Collections"], ["assets", "My NFTs"], ["market", "Deposited offers"], ["loans", "My loans"]] as const).map(([key, label]) =>
          <button key={key} aria-current={tab === key ? "page" : undefined} onClick={() => { setTab(key); setSelected(null); }}>{label}</button>)}</nav>
        {(tab === "market" || tab === "requests") && <p className="nft-tab-help">{tab === "market" ? "Lenders have already deposited the USDG for these loans. Only the owner of the specified NFT can accept, subject to the listed borrower restrictions." : "NFT owners are asking for USDG loans. Choose an NFT and offer to lend. You deposit USDG when you make an offer. The NFT owner receives it only after accepting."}</p>}
        {tab !== "collections" && <div className="nft-filters"><label>Collection<select value={collection} onChange={e => setCollection(e.target.value)}><option value="">All collections</option>
          {config?.collections.filter(c => c.enabled).map(c => <option key={c.address} value={c.address}>{c.name}</option>)}</select></label>
          <label>Search NFTs<input type="search" placeholder="Collection or token ID" value={query} onChange={e => setQuery(e.target.value)} /></label>
          <button disabled={loading || busy} onClick={() => setAttempt(x => x + 1)}>Refresh</button></div>}
        {tab !== "collections" && collection && config?.collections.find(c => same(c.address, collection))?.reason && <p className="nft-message">{config.collections.find(c => same(c.address, collection))?.reason}</p>}
        {(tab === "assets" || tab === "loans") && !account ? <EmptyState heading="h2" title={`Connect to see your ${tab === "assets" ? "NFTs" : "loans"}`} description="Connect the wallet you use for NFT lending. Connecting does not move assets or approve a loan." actions={<button className="p2p-button" disabled={session.connecting} onClick={() => void session.connect()}>Connect wallet</button>} />
          : loading && !offers.length && !requests.length && !assets.length ? <p role="status" className="nft-empty">Loading NFT lending…</p> : <>
            {tab === "collections" && <CollectionDirectory collections={config?.collections ?? []} onRequests={address => { setCollection(address); setQuery(""); setTab("requests"); }} />}
            {tab === "assets" && <div className="nft-grid">{visibleAssets.map(a => <article className="nft-card" key={`${a.collection}:${a.tokenId}`}><Art asset={a} /><div><p>{a.collectionName}</p><h2>#{a.tokenId}</h2>
              <button className="p2p-button" disabled={busy || !config?.collections.find(c => same(c.address, a.collection))?.enabled} onClick={() => begin({ kind: "request", asset: a })}>List for a loan</button></div></article>)}</div>}
            {tab === "requests" && visibleRequests.map(row => <NFTRequestCard key={row.id} row={row} asset={assetFor(row.terms.collection, row.terms.tokenId)} account={account} busy={busy} now={now}
              onLend={() => begin({ kind: "offer", asset: assetFor(row.terms.collection, row.terms.tokenId), row })}
              onRemove={() => void run(async (c, a) => { await submitNFTRequest(c, session.provider!, a, { action: "cancel", requestId: row.id, revision: row.revision, terms: row.terms }); })}
              onOpen={id => void viewOffer(BigInt(id))}
              onResume={p => { setSelected(null); setDraft(null); setConsent(false); setError(""); setNotice(""); setReview({ draft: { kind: "offer", asset: assetFor(row.terms.collection, row.terms.tokenId), row, proposal: p, terms: p.terms }, terms: p.terms }); }} />)}
            {(tab === "market" || tab === "loans") && <div className="nft-grid">{visibleOffers.map(o => <article className="nft-card" key={String(o.id)}><Art asset={assetFor(o.terms.collection, String(o.terms.tokenId))} /><div><p>{state(o)}</p><h2>{assetFor(o.terms.collection, String(o.terms.tokenId)).name}</h2><p className="nft-principal">{cash(o.terms.principal)} USDG</p><p>{cash(o.terms.interest)} USDG interest · {termPercent(o.terms.principal, o.terms.interest)} for the full term · {String(o.terms.duration / 86400n)} {o.terms.duration === 86400n ? "day" : "days"}</p>
              <button className="p2p-button p2p-secondary" onClick={() => { setSelected(o); setConsent(false); setDetailsStale(true); }}>View {o.status === 1 ? "offer" : "loan"}</button></div></article>)}</div>}
            {!loading && !error && ((tab === "assets" && !visibleAssets.length) || (tab === "requests" && !visibleRequests.length) || ((tab === "market" || tab === "loans") && !visibleOffers.length)) && <EmptyState heading="h2"
              title={query || collection ? "No NFTs match these filters" : tab === "assets" ? "No supported NFTs in this wallet" : tab === "requests" ? "No NFT loan requests yet" : tab === "loans" ? "No NFT loans in these results" : "No NFT loans ready to accept"}
              description={query || collection ? "Try another collection or token ID, or clear your filters to widen the search."
                : tab === "assets" ? "Only supported collections appear here. If your NFTs are in another wallet, switch wallets and check again."
                : tab === "requests" ? "Own an NFT from a supported collection? List it with the amount you want to borrow and let lenders make an offer."
                : tab === "loans" ? "Offers addressed to this wallet and loans you have funded or accepted will appear here."
                : "A lender needs to deposit USDG before an NFT owner can borrow. List your NFT to request a loan, or choose an NFT to lend against."}
              actions={<>{(query || collection) ? <button className="p2p-button" onClick={() => { setQuery(""); setCollection(""); }}>Clear NFT filters</button>
                : <button className="p2p-button" onClick={() => { setQuery(""); setCollection(""); setSelected(null); setTab(tab === "assets" || tab === "loans" ? "requests" : "assets"); }}>{tab === "assets" || tab === "loans" ? "Browse loan requests" : "View my NFTs"}</button>}
                {<button className="p2p-button p2p-secondary" onClick={() => { setQuery(""); setCollection(""); setSelected(null); setTab("collections"); }}>Browse collections</button>}</>}
            />}
            {cursor && <button className="p2p-button p2p-secondary nft-load" disabled={loading} onClick={() => void more()}>Load more</button>}
          </>}
      </>}
      {selected && !draft && !review && <section ref={details} tabIndex={-1} style={{ scrollMarginTop: "110px" }} className="nft-review" aria-label="NFT loan details"><button onClick={() => setSelected(null)}>Close details</button><h2>{assetFor(selected.terms.collection, String(selected.terms.tokenId)).name}</h2><p>Offer #{String(selected.id)} · {state(selected)}</p>
        {confirmed?.offerId === String(selected.id) ? <div className="nft-message" role="status"><strong>Confirmed: {confirmed.label}.</strong> <a href={`https://robinhoodchain.blockscout.com/tx/${confirmed.hash}`} target="_blank" rel="noreferrer">View transaction</a></div>
          : recentFunding?.id === String(selected.id) && <div className="nft-message" role="status"><strong>Deposit confirmed: {cash(selected.terms.principal)} USDG.</strong> <a href={`https://robinhoodchain.blockscout.com/tx/${recentFunding.hash}`} target="_blank" rel="noreferrer">View deposit transaction</a></div>}
        {[1,2].includes(selected.status) ? <Terms terms={OfferTerms(selected)} /> : <details className="nft-original-terms"><summary>Original loan terms</summary><Terms terms={OfferTerms(selected)} /></details>}
        <NFTIdentity collection={selected.terms.collection} tokenId={String(selected.terms.tokenId)} manager={config!.address} borrower={selected.terms.borrower} lender={selected.lender} />
        <p>Lender {short(selected.lender)} · Borrower {same(selected.terms.borrower, ZERO) ? "Current NFT owner" : short(selected.terms.borrower)}</p>
        <p>{selected.status === 1 ? `Offer expires ${date(selected.terms.expiresAt)}` : selected.status === 2 ? `Due ${date(selected.dueAt)} · Final deadline ${date(selected.dueAt + 86400n)}` : selected.dueAt > 0n ? "This loan is settled. Check any remaining withdrawals below." : "This offer was closed before a loan started."}</p>
        {[1,2].includes(selected.status) && <p>The entire NFT goes to the lender after default, even if it is worth more than the debt. There is no surplus refund or price-triggered liquidation.</p>}
        {detailsStale && <p role="alert">Checking the latest loan status. Refresh data if this does not finish.</p>}
        {selected.status === 3 && <p className="nft-next-step"><strong>Repayment confirmed.</strong> {same(selected.nftBeneficiary, ZERO) ? "The NFT withdrawal is complete." : "The borrower still needs to withdraw the NFT."} {selected.usdgCredit > 0n ? "The lender still needs to withdraw the USDG." : "The USDG withdrawal is complete."}</p>}
        {[5, 6].includes(selected.status) && <p className="nft-next-step"><strong>The offer is closed.</strong> {selected.usdgCredit > 0n ? same(account, selected.lender) ? "Your USDG is still in the contract. Withdraw it below to return it to your wallet." : "The lender still needs to withdraw their USDG." : "The USDG withdrawal is complete."}</p>}
        {selected.status === 4 && <p className="nft-next-step"><strong>Default settled.</strong> {same(selected.nftBeneficiary, ZERO) ? "The NFT withdrawal is complete." : "The lender still needs to withdraw the NFT below."}</p>}
        {selected.status === 1 && <p className="nft-note">{same(account, selected.lender) ? `The NFT owner approves this NFT and accepts the loan. The contract then sends them ${cash(selected.terms.principal)} USDG and holds their NFT.` : `To borrow: approve this exact NFT if needed, then accept the loan. Acceptance moves the NFT into the contract and sends you ${cash(selected.terms.principal)} USDG.`}</p>}
        {selected.status === 2 && <p className="nft-note">Full repayment is {cash(selected.terms.principal + selected.terms.interest)} USDG, even if repaid early. Repayment makes the NFT available for the borrower to withdraw.</p>}
        {[1,2].includes(selected.status) && (!same(account, selected.lender) || selected.status === 2) && <label className="p2p-check"><input type="checkbox" checked={consent} onChange={e => setConsent(e.target.checked)} />I understand these terms and the collateral risk.</label>}
        {!canWithdraw && <div className="nft-review-feedback" aria-live="polite">{actionFeedback}</div>}
        <div className="nft-actions" aria-busy={busy}>
          {selected.status === 1 && !same(account, selected.lender) && (same(selected.terms.borrower, ZERO) || same(account, selected.terms.borrower)) && <button className="p2p-button" disabled={!account || busy || pending || detailsStale || !consent || Number(selected.terms.expiresAt) <= now} onClick={() => void run(async (c, a) => {
            const current = await c.offer(selected.id);
            if (current.status !== 1) throw Error("This offer is no longer open. Refresh its status.");
            await c.approveNFT(session.provider!, a, current.terms.collection, current.terms.tokenId, status);
            await tx(c, a, encodeFunctionData({ abi: nftLendingAbi, functionName: "acceptOffer", args: [selected.id] }), `loan started — borrower received ${cash(current.terms.principal)} USDG`); await refreshSelected(c, a, selected.id);
          })}>Approve NFT and borrow {cash(selected.terms.principal)} USDG</button>}
          {selected.status === 1 && same(account, selected.lender) && <button disabled={busy || pending || detailsStale} onClick={() => void run(async (c, a) => { await tx(c, a, encodeFunctionData({ abi: nftLendingAbi, functionName: "cancelOffer", args: [selected.id] }), "offer cancellation — withdraw USDG next"); await refreshSelected(c, a, selected.id); })}>Cancel offer · withdraw USDG next</button>}
          {selected.status === 2 && same(account, selected.terms.borrower) && now <= Number(selected.dueAt) + 86400 && <button className="p2p-button" disabled={busy || pending || detailsStale || !consent} onClick={() => void run(async (c, a) => {
            status("Checking your USDG repayment balance…");
            await c.requireUSDGBalance(a, selected.terms.principal + selected.terms.interest, "repay this loan");
            await c.approveUSDG(session.provider!, a, selected.terms.principal + selected.terms.interest, status);
            await tx(c, a, encodeFunctionData({ abi: nftLendingAbi, functionName: "repay", args: [selected.id] }), "repayment — withdraw your NFT next"); await refreshSelected(c, a, selected.id);
          })}>Repay {cash(selected.terms.principal + selected.terms.interest)} USDG</button>}
          {selected.status === 2 && now > Number(selected.dueAt) + 86400 && account && <button disabled={busy || pending || detailsStale || !consent} onClick={() => void run(async (c, a) => { await tx(c, a, encodeFunctionData({ abi: nftLendingAbi, functionName: "settleDefault", args: [selected.id] }), "default settlement — NFT withdrawal is next"); await refreshSelected(c, a, selected.id); })}>Settle default · NFT goes to lender</button>}
        </div>
        {canWithdraw && <div className="nft-withdraw"><h3>Next: transfer your assets to your wallet</h3><label>Recipient wallet<input value={recipient} onChange={e => { setRecipient(e.target.value); setConsent(false); }} /></label><label className="p2p-check"><input type="checkbox" checked={consent} onChange={e => setConsent(e.target.checked)} />I checked the recipient wallet for this withdrawal.</label><div className="nft-review-feedback" aria-live="polite">{actionFeedback}</div><div className="nft-actions" aria-busy={busy}>
          {same(account, selected.nftBeneficiary) && <button className="p2p-button" disabled={busy || pending || detailsStale || !consent || !validRecipient} onClick={() => void run(async (c, a) => { await tx(c, a, encodeFunctionData({ abi: nftLendingAbi, functionName: "withdrawNFT", args: [selected.id, recipient as Address] }), "NFT sent to the recipient wallet"); await refreshSelected(c, a, selected.id); })}>Withdraw NFT</button>}
          {same(account, selected.lender) && selected.usdgCredit > 0n && <button className="p2p-button" disabled={busy || pending || detailsStale || !consent || !validRecipient} onClick={() => void run(async (c, a) => { await tx(c, a, encodeFunctionData({ abi: nftLendingAbi, functionName: "withdrawUSDG", args: [selected.id, selected.usdgCredit, recipient as Address] }), "USDG sent to the recipient wallet"); await refreshSelected(c, a, selected.id); })}>Withdraw {cash(selected.usdgCredit)} USDG</button>}
        </div></div>}
      </section>}
      {config && <NFTAlerts config={config} account={account} provider={session.provider} />}
      <details className="nft-explainer"><summary>How NFT loans work and what can go wrong</summary><p>One person funds each loan. The contract holds one specific NFT until repayment or default. Early repayment still pays the full agreed interest. Repayment is available through the final deadline, including 24 hours of grace; after that the lender can claim the entire NFT.</p><p>Collection approval checks compatibility, not value. An NFT can lose all value or be hard to sell. Its issuer may impose transfer restrictions. While locked, NFT ownership benefits and token-bound wallet access may be unavailable. This new contract has not received an independent external audit.</p></details>
    </div></div>;
  return embedded ? content : <P2PAppLayout network="Robinhood Chain" wallet={<AccountButton />}>
{content}</P2PAppLayout>;
}
