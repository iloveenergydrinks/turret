"use client";

import { LoanActionDialog } from "./LoanActionDialog";
import alertMarketScope from "../../p2p/alert-market-scope.json";
import { prioritizeMarketReads } from "../../p2p/market-read-order";
import { CollateralLogo } from "./CollateralLogo";
import { LoanMarketplace } from "./LoanMarketplace";
import { FieldLabel, TermLabel } from "../../comps/FieldInfo/FieldInfo";
import { LoanInterestField, useLoanInterest } from "../../comps/LoanInterestField/LoanInterestField";
import { termPercent } from "../../comps/LoanInterestField/interest";
import { EmptyState } from "../../comps/EmptyState/EmptyState";
import { AccountButton } from "../../comps/AppLayout/AccountButton";
import { BorrowPageHeader } from "../../borrow/BorrowPageHeader";

import { lazy, Suspense, useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import type { Address, EIP1193Provider, Hex } from "viem";
import { loadP2PRegistry, P2PClient } from "../../p2p/client";
import { loadPublicMarket, savePublicMarket } from "../../p2p/public-market-cache";
import { CollateralPicker } from "./CollateralPicker";
import { Negotiations } from "./Negotiations";
import { RequestLoanDialog } from "./RequestLoanDialog";
import { BorrowerRequests, TermsSummary } from "./BorrowerRequests";
import { CollateralMarketPrice } from "./CollateralMarketPrice";
import { P2PActivity } from "./P2PActivity";
import { PendingRecovery } from "./PendingRecovery";
import { P2PAlerts } from "../../p2p/P2PAlerts";
import { bindRequestOffer, validateRequestFunding, type RequestFundingDraft } from "../../p2p/requests";
import { useWithdrawalCredits } from "../../p2p/useWithdrawalCredits";
import { CollateralRecovery, collateralRecovery, collateralReviewKey } from "./CollateralRecovery";
import { loanCalendar } from "../../p2p/loan-calendar";
import type { Deployment, Loan, Snapshot, Terms, TransactionStage } from "../../p2p/client";
import { P2PAppLayout } from "../../p2p/P2PAppLayout";
import { WalletAvatar } from "../../profiles/WalletAvatar";
import { useWalletSession, WalletSessionProvider } from "../../wallet/useWalletSession";
import {
  collateralAmount,
  displayDate,
  Exchange,
  formatAmount,
  finalDeadline,
  V3CustodyNotice,
  GRACE,
  isLegacy,
  loanAmount,
  loanState,
  LoanTerms,
  localDateInput,
  offerKey,
  parseAmount,
  sameAddress,
  shortAddress,
  validAddress,
  ZERO_ADDRESS,
} from "./loanPresentation";
import type { Offer } from "./loanPresentation";
import { CollateralControls } from "./TermControls";
import { OfferListSkeleton } from "./PublicOfferBrowser";
import { LoanRecovery } from "./LoanRecovery";
import { V3CreditRepayment, V3Extension, V3LoanCredit } from "./V3LoanActions";
import type { V3Action } from "./V3LoanActions";
import { RepaymentFlow } from "./RepaymentFlow";
import { useDeadlineRefresh } from "./useDeadlineRefresh";
import { validateOfferDraft, type OfferErrors, type OfferField } from "./offerValidation";
import "./p2p.css";

type Browse = Awaited<ReturnType<P2PClient["browse"]>>;
type Registry = Awaited<ReturnType<typeof loadP2PRegistry>>;
type Market = {
  config: Deployment;
  client: P2PClient;
  browse: Browse | null;
  own: Snapshot | null;
  error: string | null;
  reading: boolean;
  cached?: boolean;
};
type Tab = "negotiations" | "marketplace" | "requests" | "create" | "loans" | "credits" | "activity" | "alerts";
type PersonalTab = "borrowing" | "lending" | "history" | "incoming";
const failMessage = (cause: unknown) =>
  cause && typeof cause === "object" && "shortMessage" in cause && typeof cause.shortMessage === "string"
    ? cause.shortMessage
    : cause instanceof Error
    ? cause.message
    : "The request failed. Try again.";
const mergeLoans = (
  before: Loan[],
  after: Loan[],
) => [...new Map([...before, ...after].map((loan) => [loan.id.toString(), loan])).values()];
const sectionLabels: Record<Tab, string> = { marketplace: "Marketplace", requests: "My requests", create: "Create lending offer", loans: "My loans", credits: "Withdrawals", activity: "Activity", alerts: "Alerts", negotiations: "Your negotiations" };

function revealControl(element: HTMLElement | null) {
  if (!element) return;
  const header = document.querySelector<HTMLElement>(".rusd-topbar");
  element.style.scrollMarginTop = `${(header?.getBoundingClientRect().height ?? 96) + 32}px`;
  element.focus({ preventScroll: true });
  element.scrollIntoView?.({ block: "start", behavior: "instant" });
}

/** Operate surface: inherited Turret shell, funded public offers, exact obligations, distinct withdrawal credits. */
const FacilityPage = lazy(() => import("../../facilities/FacilityPage").then(module => ({ default: module.FacilityPage })));
const StandingPage = lazy(() => import("../../facilities/StandingPage").then(module => ({ default: module.StandingPage })));
export function P2PLoansScreen({ standalone = false }: { standalone?: boolean }) {
  const [facility, setFacility] = useState(false), [standing, setStanding] = useState(false);
  useEffect(() => { const read = () => { const query = new URLSearchParams(window.location.search); setFacility(query.has("facility")); setStanding(query.has("standing")); }; read(); window.addEventListener("popstate", read); return () => window.removeEventListener("popstate", read); }, []);
  const workspace = standing && !facility ? <Suspense fallback={<p role="status">Loading standing offers…</p>}><StandingPage standalone={standalone} /></Suspense> : facility ? <Suspense fallback={<p role="status">Loading lending balance…</p>}><FacilityPage standalone={standalone} /></Suspense> : <P2PWorkspace standalone={standalone} />;
  return standalone
    ? <WalletSessionProvider>{workspace}</WalletSessionProvider>
    : workspace;
}
function P2PWorkspace({ standalone = false }: { standalone?: boolean }) {
  const [registry, setRegistry] = useState<Registry | null>(null);
  const [markets, setMarkets] = useState<Market[]>([]);
  const marketsRef = useRef<Market[]>([]);
  const session = useWalletSession();
  const [boundAccount, setAccount] = useState<Address | null>(null);
  const provider = session.provider;
  const networkMatches = !!registry?.markets.length && registry.markets.every(market => market.chainId === session.chainId);
  // Reject the previous wallet immediately, before its cleanup effect runs.
  const account = provider && networkMatches && session.account && boundAccount
    && sameAddress(session.account, boundAccount) ? boundAccount : null;
  const accountRef = useRef<Address | null>(null);
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);
  const [connecting, setConnecting] = useState(false);
  const [pending, setPending] = useState(false);
  const [requestLinking, setRequestLinking] = useState(false);
  const [negotiationBusy, setNegotiationBusy] = useState(false);
  const [stage, setStage] = useState<TransactionStage | null>(null);
  const [problem, setProblem] = useState<{ message: string; serial: number } | null>(null);
  const [notice, setNotice] = useState("");
  const errorSummary = useRef<HTMLDivElement>(null);
  const errorSerial = useRef(0);
  const epoch = useRef(0);
  const operation = useRef(false);
  const readVersion = useRef(0);
  const marketReadVersions = useRef(new Map<string, number>());
  const linkVersion = useRef(0);
  const [tab, setTab] = useState<Tab>(() => typeof window !== "undefined" && new URLSearchParams(window.location.search).get("alerts") === "verify" ? "alerts" : "marketplace");
  const [marketplaceVisit, setMarketplaceVisit] = useState(0);
  const [negotiationOffer, setNegotiationOffer] = useState<Offer | null>(null);
  const sections: [Tab, string][] = (["marketplace", "requests", "negotiations", "loans", "credits", "activity", "alerts"] as Tab[]).map(value => [value, sectionLabels[value]]);
  const [fundsTarget, setFundsTarget] = useState<"credits" | "wallet">("credits");
  const [personalTab, setPersonalTab] = useState<PersonalTab>("borrowing");
  const [selected, setSelected] = useState<Offer | null>(null);
  const selectedRef = useRef<Offer | null>(null);
  const confirmedRepayments = useRef(new Set<string>());
  const reviewReturn = useRef<string | null>(null);
  const [reviewRisk, setReviewRisk] = useState(false);
  const [collateralConsent, setCollateralConsent] = useState("");
  const withdrawalDiscovery = useWithdrawalCredits(account, markets);
  const [created, setCreated] = useState<Offer | null>(null);
  const [assetFilter, setAssetFilter] = useState("");
  const [requestMarket, setRequestMarket] = useState("");
  const [requestOpen, setRequestOpen] = useState(false);
  const [resumeRequest, setResumeRequest] = useState(false);
  const [resumeCreate, setResumeCreate] = useState(false);
  useEffect(() => { if (resumeCreate && account) { setResumeCreate(false); setTab("create"); } }, [resumeCreate, account]);
  const [requestRevision, setRequestRevision] = useState(0);
  useEffect(() => { if (resumeRequest && account) { setResumeRequest(false); setRequestOpen(true); } }, [resumeRequest, account]);
  const openRequest = (market = "") => { setRequestMarket(market); setResumeRequest(false); setRequestOpen(true); };
  const [createMarket, setCreateMarket] = useState("");
  const [visibility, setVisibility] = useState("public");
  const [borrower, setBorrower] = useState("");
  const [principal, setPrincipal] = useState("");
  const [collateral, setCollateral] = useState("");
  const activeMarket = markets.find((item) => sameAddress(item.config.address, createMarket));
  const interestModel = useLoanInterest(principal, activeMarket?.config.loanDecimals ?? 6);
  const { interest, setAmount: setInterest } = interestModel;
  const [duration, setDuration] = useState("30");
  const [expiry, setExpiry] = useState("");
  const [directFunding, setDirectFunding] = useState(false);
  const [lenderRisk, setLenderRisk] = useState(false);
  const [draft, setDraft] = useState<{ market: Deployment; terms: Terms } | null>(null);
  const [requestFunding, setRequestFunding] = useState<RequestFundingDraft | null>(null);
  const [formErrors, setFormErrors] = useState<OfferErrors>({});
  const offerForm = useRef<HTMLFormElement>(null);
  const focusInvalidField = useRef(false);
  const reviewHeading = useRef<HTMLHeadingElement>(null);
  const reviewSubmit = useRef<HTMLButtonElement>(null);
  const wasReviewingDraft = useRef(false);
  const [recipient, setRecipient] = useState("");
  const reading = markets.some((item) => item.reading);
  const busy = connecting || session.connecting || pending || requestLinking || negotiationBusy;
  const showError = (message: string) => setProblem({ message, serial: ++errorSerial.current });
  const clearFieldErrors = (...fields: OfferField[]) => setFormErrors((current) => {
    if (!fields.some((field) => current[field])) return current;
    const next = { ...current };
    for (const field of fields) delete next[field];
    return next;
  });
  const commit = (next: Market[]) => {
    marketsRef.current = next;
    setMarkets(next);
  };
  const choose = (offer: Offer | null, updateUrl = true) => {
    if (offer?.loan.status === "active" && confirmedRepayments.current.has(offerKey(offer))) {
      offer = { ...offer, loan: { ...offer.loan, status: "repaid" } };
    }
    ++linkVersion.current;
    selectedRef.current = offer;
    setSelected(offer);
    setReviewRisk(false);
    if (updateUrl) {
      const url = new URL(window.location.href);
      if (offer) {
        url.searchParams.set("market", offer.market.address);
        url.searchParams.set("offer", offer.loan.id.toString());
      } else {
        url.searchParams.delete("market");
        url.searchParams.delete("offer");
      }
      window.history.replaceState(null, "", url);
    }
  };
  const switchTab = (next: Tab) => {
    setTab(next);
    setDirectFunding(false);
    setNegotiationOffer(null);
    if (next !== "credits" && window.location.hash) {
      const url = new URL(window.location.href);
      url.hash = "";
      window.history.replaceState(null, "", url);
    }
    choose(null);
    setCreated(null);
    setDraft(null);
    setLenderRisk(false);
    setRequestFunding(null);
  };
  useEffect(() => {
    if (problem) {
      errorSummary.current?.focus();
      errorSummary.current?.scrollIntoView?.({ block: "center" });
    }
  }, [problem]);
  useEffect(() => {
    if (new URLSearchParams(window.location.search).has("negotiation")) setTab("negotiations");
  }, []);
  const selectedKey = selected ? offerKey(selected) : null;
  useEffect(() => {
    if (selectedKey) {
      reviewReturn.current = selectedKey;
      revealControl(document.getElementById("p2p-detail-heading"));
    } else if (reviewReturn.current) {
      const row = Array.from(document.querySelectorAll<HTMLElement>("[data-offer-key]"))
        .find((item) => item.dataset.offerKey === reviewReturn.current);
      revealControl(row?.querySelector<HTMLButtonElement>("[data-offer-review]") ?? row?.querySelector<HTMLButtonElement>("button") ?? null);
      reviewReturn.current = null;
    }
  }, [selectedKey]);
  useEffect(() => {
    if (draft) revealControl(reviewHeading.current);
    else if (wasReviewingDraft.current && tab === "create" && account) revealControl(reviewSubmit.current);
    wasReviewingDraft.current = !!draft;
  }, [draft, tab, account]);
  useEffect(() => {
    if (!focusInvalidField.current) return;
    focusInvalidField.current = false;
    revealControl(offerForm.current?.querySelector<HTMLElement>('[aria-invalid="true"]') ?? null);
  }, [formErrors]);

  async function readMarkets(source: Market[], older?: "public" | "own", token = epoch.current, background = false): Promise<Market[]> {
    if (token !== epoch.current) return [];
    // Retired versions remain discoverable for recovery, but are not part of marketplace startup.
    source = source.filter(item => !isLegacy(item.config) || tab === "loans" || tab === "credits"
      || (selectedRef.current && sameAddress(selectedRef.current.market.address, item.config.address))
      || new URLSearchParams(window.location.search).get("market")?.toLowerCase() === item.config.address.toLowerCase());
    const route = new URLSearchParams(window.location.search);
    source = prioritizeMarketReads(source, {
      market: selectedRef.current?.market.address ?? route.get("market"), symbol: assetFilter,
      memecoins: route.get("category") === "memecoins",
    });
    const version = ++readVersion.current;
    const readAccount = accountRef.current;
    const ids = new Set(source.map((item) => item.config.address.toLowerCase()));
    const selectedAtStart = selectedRef.current;
    const refreshedLoans = new Map<string, Map<string, Loan>>();
    for (const id of ids) marketReadVersions.current.set(id, version);
    commit(
      marketsRef.current.map((item) => ids.has(item.config.address.toLowerCase()) ? { ...item, reading: true } : item),
    );
    const valid = (item: Market) =>
      token === epoch.current
      && marketReadVersions.current.get(item.config.address.toLowerCase()) === version;
    const readOne = async (item: Market): Promise<Market> => {
      try {
        const refreshBrowse = !isLegacy(item.config) && older !== "own" && (older !== "public" || item.browse?.nextCursor != null)
          && !(readAccount && !item.own && item.browse && !item.cached && !older);
        let [browse, own] = await Promise.all([
          refreshBrowse
            ? item.client.browse(older === "public" ? item.browse?.nextCursor ?? undefined : undefined)
            : Promise.resolve(item.browse),
          readAccount && older !== "public" && (older !== "own" || item.own?.nextCursor != null)
            ? item.client.snapshot(older === "own" ? item.own?.nextCursor ?? undefined : undefined)
            : Promise.resolve(item.own),
        ]);
        if (own && (!readAccount || !sameAddress(own.account, readAccount))) {
          throw new Error("Wallet changed while loading. Reconnect to continue.");
        }
        if (background) {
          // Keep every page the user loaded, but verify its loans again so older
          // offers cannot remain actionable after acceptance or settlement.
          const previous = mergeLoans([
            ...item.browse?.offers ?? [], ...item.own?.offers ?? [], ...item.own?.incomingOffers ?? [],
          ], selectedAtStart && sameAddress(selectedAtStart.market.address, item.config.address) ? [selectedAtStart.loan] : []);
          const updated = new Map([
            ...browse?.offers ?? [], ...own?.offers ?? [], ...own?.incomingOffers ?? [],
          ].map(loan => [loan.id.toString(), loan]));
          for (const loan of previous) {
            if (!valid(item)) return { ...item, reading: false };
            if (!updated.has(loan.id.toString())) {
              const isSelected = selectedAtStart && sameAddress(selectedAtStart.market.address, item.config.address)
                && selectedAtStart.loan.id === loan.id;
              updated.set(loan.id.toString(), loan.status === "open" || loan.status === "active" || isSelected
                ? await item.client.getLoan(loan.id) : loan);
            }
          }
          refreshedLoans.set(item.config.address.toLowerCase(), updated);
          const preserve = (before: Loan[] = [], after: Loan[] = []) =>
            mergeLoans(before, after).map(loan => updated.get(loan.id.toString()) ?? loan);
          if (browse) browse = {
            ...browse,
            offers: preserve(item.browse?.offers, browse.offers).filter(loan =>
              loan.isPublic && loan.status === "open" && loan.expiresAt > browse!.now),
            nextCursor: item.browse ? item.browse.nextCursor : browse.nextCursor,
          };
          if (own) own = {
            ...own,
            offers: preserve(item.own?.offers, own.offers),
            nextCursor: item.own ? item.own.nextCursor : own.nextCursor,
            ...(own.incomingOffers ? {
              incomingOffers: preserve(item.own?.incomingOffers, own.incomingOffers)
                .filter(loan => loan.status === "open" && loan.expiresAt > own!.now),
              incomingNextCursor: item.own?.incomingNextCursor !== undefined ? item.own.incomingNextCursor : own.incomingNextCursor,
              incomingOffersComplete: own.incomingOffersMessage ? false
                : item.own?.incomingOffersComplete ?? own.incomingOffersComplete,
            } : {}),
          };
        }
        if (refreshBrowse && browse && !older && valid(item)) savePublicMarket(item.config, browse);
        return {
          ...item,
          cached: refreshBrowse ? false : item.cached,
          reading: false,
          error: older ? item.error : null,
          browse: browse && older === "public"
            ? { ...browse, offers: mergeLoans(item.browse?.offers ?? [], browse.offers) }
            : browse,
          own: own && (older === "own" || own.activeLoansComplete === false)
            ? { ...own, offers: mergeLoans(older === "own" ? item.own?.offers ?? [] : item.own?.offers.filter(loan => loan.status === "active") ?? [], own.offers) }
            : own,
        };
      } catch (cause) {
        return { ...item, reading: false, error: failMessage(cause) };
      }
    };
    const results: Market[] = [];
    let index = 0;
    await Promise.all(Array.from({ length: Math.min(12, source.length) }, async () => {
      while (index < source.length && token === epoch.current) {
        const current = index++, item = source[current]!;
        if (!valid(item)) {
          results[current] = item;
          continue;
        }
        const result = await readOne(item);
        results[current] = result;
        if (valid(item)) {
          commit(
            marketsRef.current.map((market) =>
              sameAddress(market.config.address, item.config.address) ? result : market
            ),
          );
          const current = selectedRef.current;
          const loan = current && refreshedLoans.get(item.config.address.toLowerCase())?.get(current.loan.id.toString());
          if (background && loan && current && sameAddress(current.market.address, item.config.address)) {
            // Data refresh is not a navigation event: preserve risk checks and focus.
            if (current.loan.status === "open" && (["principal", "collateral", "interest", "durationDays", "expiresAt",
              "lender", "borrower", "isPublic"] as const).some(field => current.loan[field] !== loan[field])) setReviewRisk(false);
            const next = { market: item.config, loan: loan.status === "active" && confirmedRepayments.current.has(offerKey(current))
              ? { ...loan, status: "repaid" as const } : loan };
            selectedRef.current = next;
            setSelected(next);
          }
        }
      }
    }));
    return results.filter(Boolean);
  }
  async function readLink(source: Market[], token: number) {
    const version = ++linkVersion.current;
    const params = new URLSearchParams(window.location.search);
    const marketAddress = params.get("market"), id = params.get("offer");
    if (!marketAddress && !id) {
      if(params.get("intent")==="lend") setTab("create");
      if(params.get("intent")==="request") openRequest();
      return;
    }
    if (!marketAddress || !validAddress(marketAddress) || (id !== null && !/^[1-9][0-9]{0,77}$/.test(id))) {
      showError("This offer link is invalid. Browse the marketplace to choose an offer.");
      return;
    }
    const item = source.find((item) => sameAddress(item.config.address, marketAddress));
    if (!item) {
      showError("This offer belongs to an unavailable market. Your existing loans remain under My loans.");
      return;
    }
    if (!id) {
      setCreateMarket(item.config.address);
      setAssetFilter(item.config.collateralSymbol);
      choose(null, false);
      const intent=params.get("intent");
      setTab(["#p2p-credits", "#p2p-wallet"].includes(window.location.hash) ? "credits" : intent==="lend" ? "create" : "marketplace");
      if(intent==="request") openRequest(item.config.address);
      return;
    }
    try {
      const loan = await item.client.getLoan(BigInt(id));
      if (token === epoch.current && version === linkVersion.current) {
        choose({ market: item.config, loan }, false);
        setTab("marketplace");
      }
    } catch (cause) {
      if (token === epoch.current && version === linkVersion.current) {
        showError(`Unable to load this offer. ${failMessage(cause)}`);
      }
    }
  }
  useEffect(() => {
    const token = ++epoch.current;
    let live = true;
    setLoading(true);
    setProblem(null);
    void loadP2PRegistry().then(async (result) => {
      if (!live) return;
      let sharedReads: P2PClient | undefined;
      const source = result.markets.map((config) => {
        const client = new P2PClient(config, sharedReads);
        sharedReads ??= client;
        const browse = loadPublicMarket(config);
        return { config, client, browse, own: null, error: null, reading: false, cached: !!browse };
      });
      setRegistry(result);
      commit(source);
      setCreateMarket(source.find((item) => !isLegacy(item.config))?.config.address ?? "");
      setLoading(false);
      // Wallet adoption owns its initial read; avoid starting duplicate public scans in parallel.
      if (!(session.account && provider && result.markets.every(m => m.chainId === session.chainId))) {
        await Promise.all([readMarkets(source, undefined, token), readLink(source, token)]);
      }
    }).catch((cause) => {
      if (live) showError(failMessage(cause));
    }).finally(() => {
      if (live) setLoading(false);
    });
    return () => {
      live = false;
      ++epoch.current;
    };
  }, [attempt]);
  useEffect(() => {
    const openFunds = () => {
      if (window.location.hash === "#loans") { choose(null, false); setTab("loans"); return; }
      if (["#p2p-credits", "#p2p-wallet"].includes(window.location.hash)) {
        const target = window.location.hash === "#p2p-wallet" ? "wallet" : "credits";
        setFundsTarget(target);
        choose(null, false);
        setTab("credits");
      }
    };
    openFunds();
    window.addEventListener("hashchange", openFunds);
    return () => window.removeEventListener("hashchange", openFunds);
  }, []);
  useEffect(() => {
    if (!loading && registry && tab === "credits") {
      const target = document.getElementById(fundsTarget === "wallet" ? "p2p-wallet" : "p2p-credits");
      target?.scrollIntoView?.({ block: "start" });
    }
  }, [loading, registry, tab, fundsTarget]);
  useEffect(() => {
    const onPop = () => {
      choose(null, false);
      void readLink(marketsRef.current, epoch.current);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  function resetWallet(message = "", refreshPublic = true) {
    confirmedRepayments.current.clear();
    ++epoch.current;
    ++readVersion.current;
    marketsRef.current.forEach((item) => item.client.disconnect());
    accountRef.current = null;
    setAccount(null);
    setConnecting(false);
    setRecipient("");
    const publicSource = marketsRef.current.map((item) => ({ ...item, own: null, reading: false }));
    commit(publicSource);
    setReviewRisk(false);
    setLenderRisk(false);
    setDraft(null);
    setCreated(null);
    setStage(null);
    setNotice(message);
    if (refreshPublic) void readMarkets(publicSource, undefined, epoch.current);
  }
  useEffect(() => {
    if (!registry || (!session.account && !accountRef.current)) return;
    const changed = accountRef.current !== null;
    resetWallet(changed ? "Your wallet account or network changed. Review your loan terms again." : "", !session.account || !provider || !networkMatches);
    const token = epoch.current;
    if (!session.account || !provider || !networkMatches) return;
    const connected = session.account;
    accountRef.current = connected;
    setAccount(connected);
    setRecipient(connected);
    setProblem(null);
    setConnecting(true);
    const source = marketsRef.current;
    for (const item of source) item.client.account = connected;
    // Adoption only reads receipts and balances. Opening a wallet prompt belongs
    // to the shared connector UI; a page visit must never request a signature.
    // Pending status must not delay access to other markets or an urgent repayment.
    // Each write still reconciles its own saved transaction before any broadcast.
    void readMarkets(source, undefined, token);
    void readLink(source, token);
    setConnecting(false);
    for (const item of source) void (async () => {
      try {
        const recovered = await item.client.reconcilePending(next => {
          if (token === epoch.current) setStage(next);
        });
        if (!recovered) return;
      } catch (cause) {
        if (token === epoch.current) showError(failMessage(cause));
      }
      if (token === epoch.current) {
        void readMarkets([item], undefined, token);
        void readLink(source, token);
      }
    })();
    return () => { ++epoch.current; };
  }, [session.account, session.chainId, provider, networkMatches, registry]);
  useEffect(() => {
    if (!account || !registry) return;
    if (tab !== "loans" && tab !== "credits" && !(selected && isLegacy(selected.market))) return;
    const targets = marketsRef.current.filter(item => isLegacy(item.config) && !item.own && !item.reading && !item.error);
    if (targets.length) void readMarkets(targets, undefined, epoch.current);
  }, [tab, account, registry, selected?.market.address]);
  function disconnect() {
    resetWallet();
    session.disconnect();
  }
  async function connectWallet() {
    if (operation.current) return;
    setProblem(null);
    try { await session.connect(); }
    catch (cause) { showError(failMessage(cause)); }
  }
  async function recoverSavedTransaction(address: Address, replacement?: Hex) {
    if (!account || busy || operation.current) return;
    const item = marketsRef.current.find(market => sameAddress(market.config.address, address));
    if (!item) return;
    const token = epoch.current;
    operation.current = true; setPending(true); setProblem(null); setStage(null); setNotice("");
    try {
      await item.client.reconcilePending(next => { if (token === epoch.current) setStage(next); }, replacement);
    } catch (cause) {
      if (token === epoch.current) showError(failMessage(cause));
    } finally {
      if (token === epoch.current) {
        await readMarkets(marketsRef.current, undefined, token);
        if (token === epoch.current) void readLink(marketsRef.current, token);
      }
      operation.current = false; setPending(false);
    }
  }
  async function refresh(older?: "public" | "own", onlyMarket?: string) {
    if (operation.current) return;
    setProblem(null);
    const token = epoch.current;
    const targets = marketsRef.current.filter((item) =>
      !item.reading && (!onlyMarket || sameAddress(item.config.address, onlyMarket))
    );
    if (!targets.length) return;
    const fresh = await readMarkets(targets, older, token);
    const current = selectedRef.current;
    if (current && token === epoch.current) {
      const item = fresh.find((item) => sameAddress(item.config.address, current.market.address));
      try {
        if (item) {
          const loan = await item.client.getLoan(current.loan.id);
          if (token === epoch.current && selectedRef.current && offerKey(selectedRef.current) === offerKey(current)) {
            choose({ market: item.config, loan }, false);
          }
        }
      } catch (cause) {
        if (token === epoch.current) {
          commit(
            marketsRef.current.map((market) =>
              sameAddress(market.config.address, current.market.address)
                ? { ...market, error: failMessage(cause) }
                : market
            ),
          );
          showError(`Unable to refresh this loan. ${failMessage(cause)}`);
        }
      }
    }
  }
  useDeadlineRefresh({
    enabled: !!registry && !loading,
    paused: busy || reading,
    observations: markets.flatMap(item => {
      const snapshot = item.own ?? item.browse;
      return snapshot ? [{ now: snapshot.now, blockNumber: snapshot.blockNumber, loans: [
        ...item.browse?.offers ?? [], ...item.own?.offers ?? [], ...item.own?.incomingOffers ?? [],
        ...(selected && sameAddress(selected.market.address, item.config.address) ? [selected.loan] : []),
      ] }] : [];
    }),
    refresh: async () => {
      if (operation.current || busy || marketsRef.current.some(item => item.reading)) return;
      await readMarkets(marketsRef.current, undefined, epoch.current, true);
    },
  });
  async function retryFailedMarkets() {
    if (operation.current) return;
    const targets = marketsRef.current.filter((item) => item.error && !item.reading);
    if (!targets.length) return;
    await readMarkets(targets, undefined, epoch.current, true);
  }
  async function loadIncoming() {
    if (operation.current || !accountRef.current) return;
    const token = epoch.current, readAccount = accountRef.current;
    const source = marketsRef.current.filter(item => item.config.version === 3 && item.own && !item.reading
      && (item.own.incomingNextCursor != null || item.own.incomingOffersMessage));
    const version = ++readVersion.current;
    for (const item of source) marketReadVersions.current.set(item.config.address.toLowerCase(), version);
    const ids = new Set(source.map(item => item.config.address.toLowerCase()));
    commit(marketsRef.current.map(item => ids.has(item.config.address.toLowerCase()) ? { ...item, reading: true } : item));
    await Promise.all(source.map(async item => {
      let page: Awaited<ReturnType<P2PClient["getIncomingOffers"]>> | undefined, message: string | undefined;
      const older = item.own!.incomingNextCursor != null;
      try { page = await item.client.getIncomingOffers(item.own!.incomingNextCursor ?? 0n); }
      catch { message = "Incoming offers could not be loaded. Your existing loans remain available. Retry the inbox."; }
      if (token !== epoch.current || accountRef.current !== readAccount || marketReadVersions.current.get(item.config.address.toLowerCase()) !== version) return;
      commit(marketsRef.current.map(current => sameAddress(current.config.address, item.config.address) && current.own
        ? { ...current, reading: false, own: { ...current.own,
          incomingOffers: page ? older ? mergeLoans(current.own.incomingOffers ?? [], page.offers) : page.offers : current.own.incomingOffers,
          incomingNextCursor: page?.nextCursor ?? (page ? null : current.own.incomingNextCursor),
          incomingOffersComplete: page ? page.nextCursor === null : false, incomingOffersMessage: message,
        } } : current));
    }));
  }
  async function transact(
    item: Market,
    run: (client: P2PClient, provider: EIP1193Provider, onStage: (stage: TransactionStage) => void) => Promise<unknown>,
    success: string,
  ) {
    if (!account || !provider || !item.own || item.error || item.reading || operation.current || requestLinking) return null;
    operation.current = true;
    setPending(true);
    setProblem(null);
    setNotice("");
    setStage(null);
    const token = epoch.current;
    try {
      await run(item.client, provider, (next) => {
        if (token === epoch.current) setStage(next);
      });
      if (token !== epoch.current) return null;
      setNotice(success);
      setReviewRisk(false);
      setLenderRisk(false);
      const fresh = await readMarkets(
        marketsRef.current.filter((market) => sameAddress(market.config.address, item.config.address)),
        undefined,
        token,
      );
      if (token !== epoch.current) return null;
      if (fresh.some((market) => market.error)) {
        setNotice(`${success} Some balances could not be refreshed. Retry before another transaction.`);
      }
      const current = selectedRef.current;
      if (current && sameAddress(current.market.address, item.config.address)) {
        try {
          const loan = await item.client.getLoan(current.loan.id);
          if (token === epoch.current) choose({ market: item.config, loan }, false);
        } catch (cause) {
          if (token === epoch.current) {
            commit(
              marketsRef.current.map((market) =>
                sameAddress(market.config.address, item.config.address)
                  ? { ...market, error: failMessage(cause) }
                  : market
              ),
            );
            showError(`The transaction confirmed, but the loan could not be refreshed. ${failMessage(cause)}`);
          }
        }
      }
      return token === epoch.current ? fresh : null;
    } catch (cause) {
      if (token === epoch.current) {
        const message = failMessage(cause);
        await readMarkets(
          marketsRef.current.filter((market) => sameAddress(market.config.address, item.config.address)),
          undefined,
          token,
        );
        if (token === epoch.current) {
          const current = selectedRef.current;
          if (current && sameAddress(current.market.address, item.config.address)) {
            try {
              const loan = await item.client.getLoan(current.loan.id);
              if (token === epoch.current) choose({ market: item.config, loan }, false);
            } catch (refreshCause) {
              if (token === epoch.current) {
                commit(marketsRef.current.map((market) =>
                  sameAddress(market.config.address, item.config.address)
                    ? { ...market, error: failMessage(refreshCause) }
                    : market
                ));
              }
            }
          }
          if (token === epoch.current) showError(message);
        }
      }
      return null;
    } finally {
      operation.current = false;
      setPending(false);
      if (token === epoch.current) {
        void readMarkets(
          marketsRef.current.filter((market) =>
            !market.reading && !sameAddress(market.config.address, item.config.address)
          ),
          undefined,
          token,
        );
      }
    }
  }

  const newMarkets = markets.filter((item) => !isLegacy(item.config));
  const knownNow = activeMarket?.own?.now ?? activeMarket?.browse?.now;
  useEffect(() => {
    if (!expiry && knownNow) setExpiry(localDateInput(knownNow + GRACE));
  }, [knownNow, expiry]);
  function reviewOffer(event: FormEvent) {
    event.preventDefault();
    if (!activeMarket?.own || activeMarket.error) return;
    if (creationReason) {
      showError(creationReason);
      return;
    }
    const result = validateOfferDraft(
      { visibility, borrower, principal, collateral, interest, duration, expiry },
      { market: activeMarket.config, account: activeMarket.own.account,
        balance: activeMarket.own.balances.USDG, now: activeMarket.own.now,
        marketAddresses: markets.map((item) => item.config.address) },
    );
    setProblem(null);
    focusInvalidField.current = !result.terms;
    setFormErrors(result.errors);
    if (!result.terms) return;
    setLenderRisk(false);
    setDraft({ market: activeMarket.config, terms: result.terms });
  }
  function fundRequest(proposal: RequestFundingDraft, immediately = false) {
    const item = marketsRef.current.find(market => sameAddress(market.config.address, proposal.market.address));
    if (!item || !account || !accountRef.current || !sameAddress(accountRef.current, account)) return;
    switchTab("create");
    setCreateMarket(item.config.address); setVisibility("private"); setBorrower(proposal.borrower);
    setPrincipal(formatAmount(proposal.principal, item.config.loanDecimals));
    setCollateral(formatAmount(proposal.collateral, item.config.collateralDecimals));
    setInterest(formatAmount(proposal.interest, item.config.loanDecimals));
    setDuration(String(proposal.durationDays)); setExpiry(localDateInput(proposal.expiresAt));
    setRequestFunding(proposal); setFormErrors({});
    setDraft({ market: item.config, terms: proposal });
    setDirectFunding(immediately);
    if (immediately) {
      setLenderRisk(true);
      void fundOffer({ market: item.config, terms: proposal }, proposal, true);
    }
  }
  async function fundOffer(reviewed = draft, linkedRequest = requestFunding, consent = lenderRisk) {
    if (!reviewed || !consent) return;
    const item = marketsRef.current.find((item) => sameAddress(item.config.address, reviewed.market.address));
    if (!item) return;
    const reason = fundingReason(item);
    if (reason) { showError(reason); return; }
    const checked = validateOfferDraft({ visibility: sameAddress(reviewed.terms.borrower, ZERO_ADDRESS) ? "public" : "private",
      borrower: reviewed.terms.borrower, principal: formatAmount(reviewed.terms.principal, item.config.loanDecimals),
      collateral: formatAmount(reviewed.terms.collateral, item.config.collateralDecimals), interest: formatAmount(reviewed.terms.interest, item.config.loanDecimals),
      duration: String(reviewed.terms.durationDays), expiry: localDateInput(reviewed.terms.expiresAt) },
      { market: item.config, account: account!, balance: item.own!.balances.USDG, now: item.own!.now, marketAddresses: marketsRef.current.map(m => m.config.address) });
    if (!checked.terms) { showError(Object.values(checked.errors).join(" ")); return; }
    const before = new Set(item.own?.offers.map((loan) => loan.id.toString()));
    const terms = reviewed.terms;
    const fundingAccount = account;
    const fundingEpoch = epoch.current;
    const fresh = await transact(
      item,
      (client, wallet, onStage) => linkedRequest && fundingAccount
        ? validateRequestFunding(linkedRequest, fundingAccount, terms).then(() => client.createOffer(wallet, terms, onStage, async () => { await validateRequestFunding(linkedRequest, fundingAccount, terms); }))
        : client.createOffer(wallet, terms, onStage),
      "Offer funded. Its USDG is reserved until acceptance, cancellation or expiry.",
    );
    if (!fresh) return;
    const result = fresh.find((market) => sameAddress(market.config.address, item.config.address))?.own?.offers.find(
      (loan) =>
        !before.has(loan.id.toString()) && loan.principal === terms.principal && loan.collateral === terms.collateral
        && loan.interest === terms.interest && loan.expiresAt === terms.expiresAt
        && loan.durationDays === terms.durationDays && sameAddress(loan.borrower, terms.borrower)
        && !!fundingAccount && sameAddress(loan.lender, fundingAccount),
    );
    setDraft(null);
    setRequestFunding(null);
    setPersonalTab("lending");
    setTab("loans");
    if (result) {
      setCreated({ market: item.config, loan: result });
      if (linkedRequest && provider && fundingAccount && accountRef.current && sameAddress(accountRef.current, fundingAccount)) {
        setRequestLinking(true);
        try {
          await bindRequestOffer(provider, fundingAccount, linkedRequest, result.id);
          if (fundingEpoch === epoch.current) setNotice("Offer funded and linked to the borrower request. The borrower must accept the loan separately.");
        } catch {
          if (fundingEpoch === epoch.current) showError("Your offer was funded successfully, but its request link was not saved. Do not fund again. Open Requests and use Already funded? Link the offer with loan ID " + result.id + ".");
        } finally { setRequestLinking(false); }
      }
    }
  }
  async function copyLink(offer: Offer) {
    const url = new URL("/borrow/p2p", window.location.origin);
    url.searchParams.set("market", offer.market.address);
    url.searchParams.set("offer", offer.loan.id.toString());
    try {
      await navigator.clipboard.writeText(url.href);
      setNotice("Offer link copied.");
    } catch {
      showError(`Could not copy the link. Open this offer and copy the page address: ${url.href}`);
    }
  }
  async function openOffer(offer: Offer) {
    const item = marketsRef.current.find(m => sameAddress(m.config.address, offer.market.address));
    if (item?.cached) {
      const token = epoch.current, link = ++linkVersion.current;
      try {
        const loan = await item.client.getLoan(offer.loan.id);
        if (token !== epoch.current || link !== linkVersion.current) return;
        choose({ ...offer, loan });
      } catch { showError("This offer could not be refreshed. Retry before reviewing its terms."); return; }
    } else choose(offer);
    setCreated(null);
  }
  const publicOffers = markets.flatMap((item) =>
    item.browse?.offers.filter((loan) => loan.isPublic && loan.status === "open" && loan.expiresAt > item.browse!.now)
      .map((loan) => ({ market: item.config, loan })) ?? []
  );
  const personal = markets.flatMap((item) => item.own?.offers.map((loan) => ({ market: item.config, loan })) ?? []);
  const currentOffer = selected;
  const incoming = markets.flatMap(item => item.own?.incomingOffers?.map(loan => ({ market: item.config, loan })) ?? []);
  const currentPersonal = (personalTab === "incoming" ? incoming : personal).filter(({ loan }) => {
    if (personalTab === "incoming") return loan.status === "open" && !!account && sameAddress(loan.borrower, account);
    const settled = !["open", "active"].includes(loan.status);
    return personalTab === "history"
      ? settled
      : !settled && !!account && sameAddress(personalTab === "borrowing" ? loan.borrower : loan.lender, account);
  }).sort((a, b) => {
    const dueA = a.loan.status === "active" ? a.loan.dueAt : Number.MAX_SAFE_INTEGER;
    const dueB = b.loan.status === "active" ? b.loan.dueAt : Number.MAX_SAFE_INTEGER;
    return dueA - dueB || b.loan.createdAt - a.loan.createdAt;
  });
  const hasPublicMore = markets.some((item) => item.browse?.nextCursor != null);
  const hasOwnMore = markets.some((item) => item.own?.nextCursor != null);
  const connectedData = markets.find((item) => item.own && !item.error)?.own;
  const failures = markets.filter((item) => item.error);
  const publicPending = newMarkets.some((item) =>
    (!assetFilter || item.config.collateralSymbol === assetFilter)
    && !item.browse && !item.error
  );
  const ownPending = !!account && markets.some((item) => item.reading || (!item.own && !item.error));
  const readonlyReason = (item?: Market) =>
    !account
      ? "Connect your wallet to continue."
      : item?.reading || item?.cached
      ? "This market’s wallet data is loading. Its actions will be ready after verification."
      : !item?.own
      ? "Wallet data is unavailable. Refresh to continue."
      : item.error
      ? "This market’s data could be out of date. Refresh successfully before submitting."
      : item.own.nativeBalance === 0n
      ? "Your wallet needs ETH for network fees."
      : "";
  const fundingReason = (item?: Market) => readonlyReason(item)
    || (item?.own?.balancesUnavailable?.USDG ? "Your USDG wallet balance could not be read. Refresh this market before funding an offer." : "")
    || (item?.own?.health && item.own.health.status !== "ok" ? item.own.health.reasons.join(" ") : "")
    || (item?.own?.paused
      ? "New offers are paused. Existing repayment and withdrawal actions remain available."
      : "");
  const creationReason = fundingReason(activeMarket);
  const canWrite = (item?: Market) => !busy && !readonlyReason(item);
  function loanCard(offer: Offer, detailed = false) {
    const { market, loan } = offer;
    const item = markets.find((item) => sameAddress(item.config.address, market.address));
    const own = item?.own;
    const now = own?.now ?? item?.browse?.now ?? 0;
    const expired = loan.status === "open" && now >= loan.expiresAt;
    const isLender = !!account && sameAddress(account, loan.lender);
    const isBorrower = !!account && sameAddress(account, loan.borrower);
    const eligible = !!account && !isLender && (loan.isPublic || isBorrower);
    const active = loan.status === "active";
    const canRepay = active && now <= finalDeadline(loan);
    const collateralNeedsConsent = market.version === 3 && (collateralRecovery(loan).available === undefined || (collateralRecovery(loan).shortfall ?? 0n) > 0n);
    const collateralReviewed = !collateralNeedsConsent || collateralConsent === collateralReviewKey(market, loan);
    const defaulted = active && now > finalDeadline(loan);
    const acceptanceReason = readonlyReason(item)
      || (own?.balancesUnavailable?.COLLATERAL ? "Your collateral wallet balance could not be read. Refresh this market before accepting." : "")
      || (own?.health && own.health.status !== "ok" ? own.health.reasons.join(" ") : "")
      || (market.version === 3 ? loan.fundingAvailable === undefined ? "This offer’s funding balance could not be verified. Refresh this market before accepting." : loan.fundingAvailable < loan.principal ? "This offer’s vault no longer holds its full funding. The lender can cancel it and recover what remains." : "" : "")
      || (own?.paused
        ? "Acceptance is paused. Try again when new loans resume."
        : !eligible
        ? "Only the specified borrower can accept this offer."
        : own && own.balances.COLLATERAL < loan.collateral
        ? `Your wallet needs ${collateralAmount(loan.collateral, market)} to accept.`
        : !reviewRisk
        ? "Read and acknowledge the collateral risk to continue."
        : "");
    const runId = (action: "accept" | "cancel" | "expire" | "repay" | "claim", success: string) =>
      item && void transact(item, (client, wallet, onStage) => client[action](wallet, loan.id, onStage), success);
    const runRepayment = (action: V3Action, success: string) => {
      if (!item) return;
      const token = epoch.current;
      void transact(item, async (client, wallet, onStage) => {
        const receipt = await action(client, wallet, onStage);
        if (token === epoch.current) {
          confirmedRepayments.current.add(offerKey(offer));
          if (selectedRef.current && offerKey(selectedRef.current) === offerKey(offer)) {
            choose({ ...offer, loan: { ...loan, status: "repaid" } }, false);
          }
        }
        return receipt;
      }, success);
    };
    return (
      <article className="p2p-offer" key={offerKey(offer)} aria-label={`${market.collateralSymbol} offer ${loan.id}`}>
        <div className="p2p-offer-heading">
          <div>
            <h2 id={detailed ? "p2p-detail-heading" : undefined} tabIndex={detailed ? -1 : undefined}>
              <CollateralLogo market={market} />{market.collateralSymbol} loan <span className="p2p-offer-number">#{loan.id.toString()}</span>
            </h2>
            <p>
              {market.version === 3 ? "V3 · Isolated vault · " : isLegacy(market) ? market.version === 2 ? "Previous contract · " : "Original SLV pilot · " : ""}
              {loan.isPublic ? "Public offer" : "Private offer"} · Lender{" "}
              <span className="p2p-wallet-identity" title={loan.lender}>
                <WalletAvatar address={loan.lender} size={22} />
                {shortAddress(loan.lender)}
              </span>
              {validAddress(loan.borrower) && (
                <span>
                  · Borrower{" "}
                  <span className="p2p-wallet-identity" title={loan.borrower}>
                    <WalletAvatar address={loan.borrower} size={22} />
                    {shortAddress(loan.borrower)}
                  </span>
                </span>
              )}
            </p>
          </div>
          <span className={`p2p-status ${defaulted ? "p2p-status-danger" : ""}`}>{loanState(loan, now)}</span>
        </div>
        <LoanTerms offer={offer} now={now} account={account} detailed={detailed} />
        {detailed && <CollateralMarketPrice market={market} amount={formatAmount(loan.collateral, market.collateralDecimals)} />}
        {!detailed
          ? (
            <button
              className="p2p-button p2p-secondary"
              onClick={() => openOffer(offer)}
            >
              Review loan
            </button>
          )
          : (
            <>
              <details className="p2p-parties">
                <summary>Wallets and token identity</summary>
                <p>
                  Lender{" "}
                  <span className="p2p-wallet-identity">
                    <WalletAvatar address={loan.lender} size={28} />
                    <span className="p2p-address">{loan.lender}</span>
                  </span>
                </p>
                <p>
                  Borrower{" "}
                  <span className="p2p-address">
                    {!validAddress(loan.borrower)
                      ? loan.status === "open" ? "Any eligible wallet" : "No borrower · offer not accepted"
                      : (
                        <span className="p2p-wallet-identity">
                          <WalletAvatar address={loan.borrower} size={28} />
                          {loan.borrower}
                        </span>
                      )}
                  </span>
                </p>
                <p>
                  {market.collateralName ?? market.collateralSymbol}
                  <span className="p2p-address">{market.collateralToken}</span>
                </p>
                <p>
                  {market.chainName} · {isLegacy(market) ? market.version === 2 ? "Previous lending contract" : "Original pilot contract" : "Lending contract"}
                  <span className="p2p-address">{market.address}</span>
                </p>
                {market.version === 3 && loan.vault && <p>
                  Vault holding this offer’s tokens
                  <span className="p2p-address">{loan.vault}</span>
                </p>}
              </details>
              <div className="p2p-offer-action">
                {loan.status === "open" && !expired && !isLender && (
                  <>
                    {!loan.isPublic && (
                      <p>
                        Only {shortAddress(loan.borrower)}{" "}
                        can accept. Private offers are restricted to a wallet; their terms are visible on-chain.
                      </p>
                    )}
                    <p>
                      Accepting locks {collateralAmount(loan.collateral, market)} and sends{" "}
                      {loanAmount(loan.principal, market)}{" "}
                      to your wallet. Reviewing or approving does not reserve this offer.
                    </p>
                    {!account
                      ? (
                        <button
                          className="p2p-button"
                          disabled={busy}
                          onClick={() => void connectWallet()}
                        >
                          Connect to accept
                        </button>
                      )
                      : (
                        <>
                          {eligible && (
                            <label className="p2p-check">
                              <input
                                type="checkbox"
                                checked={reviewRisk}
                                disabled={busy}
                                onChange={(event) => setReviewRisk(event.target.checked)}
                              />
                              <span>
                                I must repay {loanAmount(loan.principal + loan.interest, market)} within{" "}
                                {loan.durationDays} days plus the 24-hour grace period after acceptance, or lose all
                                {" "}
                                {collateralAmount(loan.collateral, market)}. Early repayment still owes the full fee.
                              </span>
                            </label>
                          )}
                          <button
                            className="p2p-button"
                            disabled={!canWrite(item) || !!acceptanceReason}
                            onClick={() =>
                              runId(
                                "accept",
                                "Loan accepted. Collateral is locked and the principal was transferred to your wallet.",
                              )}
                          >
                            Accept loan
                          </button>
                          {acceptanceReason && <p className="p2p-help">{acceptanceReason}</p>}
                        </>
                      )}
                  </>
                )}
                {loan.status === "open" && !expired && isLender && (
                  <>
                    <p>To get your funding back before acceptance, cancel this offer, then withdraw the released USDG.</p>
                    <button
                      className="p2p-button p2p-secondary"
                      disabled={!canWrite(item)}
                      onClick={() =>
                        runId("cancel", "Offer cancelled. The principal is available under Available to withdraw.")}
                    >
                      Cancel offer
                    </button>
                  </>
                )}
                {expired && (
                  <>
                    <p>
                      The offer expired without a loan. Release the reserved USDG to the lender’s withdrawal credit.
                    </p>
                    <button
                      className="p2p-button p2p-secondary"
                      disabled={!canWrite(item)}
                      onClick={() => runId("expire", "Expired funding released to the lender’s withdrawal credit.")}
                    >
                      Release expired funds
                    </button>
                  </>
                )}
                {(canRepay || (isBorrower && loan.status === "repaid")) && <RepaymentFlow
                  key={`repayment:${offerKey(offer)}:${account}`} market={market} loan={loan} account={account}
                  snapshot={own ?? null} disabled={!canWrite(item)}
                  run={(action, success) => { if (item) void transact(item, action, success); }}
                >
                {canRepay && (
                  <>
                    <CollateralRecovery market={market} loan={loan} />
                    {collateralNeedsConsent && <label className="p2p-check"><input type="checkbox" checked={collateralReviewed} onChange={event => setCollateralConsent(event.target.checked ? collateralReviewKey(market, loan) : "")} /><span>I understand the collateral recovery shown above and still want to repay the full agreed debt.</span></label>}
                    <p>
                      {isBorrower
                        ? "Repay the full agreed amount to unlock your collateral for withdrawal. Partial repayments are not supported; early repayment still owes the entire fee."
                        : "Repaying on behalf of the borrower spends your own wallet funds. Collateral returns to the borrower’s withdrawal credit."}
                    </p>
                    <p className="p2p-help">Repayment must confirm by {displayDate(finalDeadline(loan))}. Token restrictions or a network outage do not extend this deadline. Repay early.</p>
                    <button type="button" className="p2p-reset" onClick={() => {
                      const url = new URL("/borrow/p2p", window.location.origin);
                      url.searchParams.set("market", market.address); url.searchParams.set("offer", loan.id.toString());
                      const calendar = loanCalendar({ market, loan, url: url.href });
                      if (!calendar) { showError("A reminder could not be created for these loan dates."); return; }
                      const download = URL.createObjectURL(new Blob([calendar.content], { type: "text/calendar;charset=utf-8" }));
                      const link = document.createElement("a"); link.href = download; link.download = calendar.filename;
                      document.body.append(link); link.click(); link.remove();
                      setTimeout(() => URL.revokeObjectURL(download), 1000);
                    }}>Download calendar reminders</button>
                    <p className="p2p-help">Import the file into your calendar for reminders one day and one hour before the final deadline. Remove them after repayment and replace them after an agreed extension; they do not update automatically.</p>
                    <button
                      className="p2p-button"
                      disabled={!canWrite(item) || !collateralReviewed || !own || own.balancesUnavailable?.USDG || own.balances.USDG < loan.principal + loan.interest}
                      onClick={() =>
                        runRepayment(
                          (client, wallet, onStage) => client.repay(wallet, loan.id, onStage),
                          isBorrower ? `Loan repaid. Next, withdraw your ${market.collateralSymbol} below.` : "Loan repaid. The borrower can now withdraw their collateral.",
                        )}
                    >
                      Repay {loanAmount(loan.principal + loan.interest, market)}
                    </button>
                    {own?.balancesUnavailable?.USDG && <p className="p2p-help">Your USDG wallet balance could not be read. Refresh before paying from your wallet. Repayment entirely from verified credits remains available.</p>}
                    {own && !own.balancesUnavailable?.USDG && own.balances.USDG < loan.principal + loan.interest && (
                      <p className="p2p-help">
                        Your wallet needs {loanAmount(loan.principal + loan.interest, market)} for full repayment.
                      </p>
                    )}
                    {market.version !== 3 && own && account && own.balances.USDG < loan.principal + loan.interest
                      && own.credits.USDG >= loan.principal + loan.interest - own.balances.USDG && (
                      <div className="p2p-repayment-credit">
                        <p className="p2p-help">Your withdrawal credit covers the missing USDG. Withdraw it first, then confirm repayment. These are two separate transactions.</p>
                        <button className="p2p-button p2p-secondary" disabled={!canWrite(item)} onClick={() => item && void transact(item,
                          (client, wallet, onStage) => client.withdraw(wallet, "USDG", loan.principal + loan.interest - own.balances.USDG, account, onStage),
                          "USDG withdrawn to your wallet. Confirm repayment to settle this loan.")}>Withdraw USDG for repayment</button>
                      </div>
                    )}
                  </>
                )}
                {market.version === 3 && canRepay && own && account && item && <V3CreditRepayment
                  key={`repay:${offerKey(offer)}`} market={market} loan={loan} account={account}
                  disabled={!canWrite(item) || !collateralReviewed} walletBalance={own.balances.USDG} walletBalanceUnavailable={own.balancesUnavailable?.USDG} loans={mergeLoans(own.offers, withdrawalDiscovery.entries[market.address.toLowerCase()]?.loans ?? [])}
                  run={runRepayment}
                />}
                </RepaymentFlow>}
                {market.version === 3 && active && account && item && <V3Extension
                  key={`extension:${offerKey(offer)}`} market={market} loan={loan} account={account} now={now}
                  disabled={!canWrite(item)} run={(action, success) => { void transact(item, action, success); }}
                />}
                {defaulted && (
                  <>
                    <p>
                      <strong>The final deadline has passed.</strong> {market.version === 3 ? "The collateral remaining in this loan’s vault goes to the lender." : `All ${collateralAmount(loan.collateral, market)} goes to the lender.`} No further USDG is due after settlement. Collateral may be worth less or more
                      than the debt.
                    </p>
                    <button
                      className="p2p-button"
                      disabled={!canWrite(item)}
                      onClick={() =>
                        runId(
                          "claim",
                          "Remaining collateral credited to the lender. The loan is settled; no further repayment is due.",
                        )}
                    >
                      {isLender ? "Claim all collateral" : "Settle collateral to lender"}
                    </button>
                  </>
                )}
                {loan.status === "repaid" && !isBorrower && (
                  <p>
                    Repaid. The lender’s principal and interest and the borrower’s collateral are available to withdraw
                    separately.
                  </p>
                )}
                {loan.status === "claimed" && (
                  <p>
                    Settled in collateral. The lender can withdraw{" "}
                    {market.version === 3 ? "the remaining collateral shown in this loan’s withdrawal credits" : collateralAmount(loan.collateral, market)}. The borrower owes no further USDG.
                  </p>
                )}
                {["cancelled", "expired"].includes(loan.status) && (
                  <p>No loan was opened. Released principal is available to the lender under Available to withdraw.</p>
                )}
                {market.version === 3 && account && item && loan.loanCredits && <section>
                  <h3>Other withdrawal options</h3>
                  {(["USDG", "COLLATERAL"] as const).some(token => loan.loanCredits![token].nominal > 0n && sameAddress(loan.loanCredits![token].beneficiary, account)) && <label className="p2p-field-block" htmlFor="p2p-loan-withdrawal-recipient">Withdrawal recipient<input id="p2p-loan-withdrawal-recipient" value={recipient} disabled={busy} onChange={event => setRecipient(event.target.value)} spellCheck={false} autoCapitalize="none" /></label>}
                  {(["USDG", "COLLATERAL"] as const).map(token => <V3LoanCredit key={`${loan.id}:${token}`} market={market} loan={loan} account={account} token={token} recipient={recipient} disabled={!canWrite(item)} run={(action, success) => { void transact(item, action, success); }} />)}
                </section>}
                {account && readonlyReason(item) && <p className="p2p-help">{readonlyReason(item)}</p>}
                {!account && (expired || active) && (
                  <button
                    className="p2p-button"
                    disabled={busy}
                    onClick={() => void connectWallet()}
                  >
                    Connect wallet to manage loan
                  </button>
                )}
              </div>
              <button
                className="p2p-reset"
                disabled={pending || negotiationBusy}
                onClick={() =>
                  void copyLink(offer)}
              >
                Copy offer link
              </button>
            </>
          )}
      </article>
    );
  }
  const draftPrincipal = (() => {
    try {
      return activeMarket
        ? loanAmount(parseAmount(principal, activeMarket.config.loanDecimals), activeMarket.config)
        : "—";
    } catch {
      return "—";
    }
  })();
  const draftCollateral = (() => {
    try {
      return activeMarket
        ? collateralAmount(parseAmount(collateral, activeMarket.config.collateralDecimals), activeMarket.config)
        : "—";
    } catch {
      return "—";
    }
  })();
  const draftTotal = (() => {
    try {
      return activeMarket
        ? loanAmount(
          parseAmount(principal, activeMarket.config.loanDecimals)
            + parseAmount(interest, activeMarket.config.loanDecimals),
          activeMarket.config,
        )
        : "Enter your loan terms";
    } catch {
      return "Enter your loan terms";
    }
  })();
  const balances = markets.filter((item) => item.own && !item.error).filter((item, index, all) =>
    all.findIndex((other) => sameAddress(item.config.collateralToken, other.config.collateralToken)) === index
  );
  const v3Credits = markets.flatMap(item => item.config.version === 3 && item.own && account
    ? (withdrawalDiscovery.entries[item.config.address.toLowerCase()]?.complete
      ? withdrawalDiscovery.entries[item.config.address.toLowerCase()]!.loans
      : mergeLoans(item.own.offers, withdrawalDiscovery.entries[item.config.address.toLowerCase()]?.loans ?? [])).flatMap(loan => (["USDG", "COLLATERAL"] as const)
      .filter(token => loan.loanCredits?.[token] && (loan.loanCredits[token].unavailable ? sameAddress(loan.lender, account) || sameAddress(loan.borrower, account) : sameAddress(loan.loanCredits[token].beneficiary, account) && loan.loanCredits[token].nominal > 0n))
      .map(token => ({ item, loan, token })))
    : []);
  const credits = markets.flatMap((item) =>
    item.own
      && item.config.version !== 3 ? (["USDG", "COLLATERAL"] as const).filter((token) => item.own!.credits[token] > 0n).map((token) => ({
        item,
        token,
        amount: item.own!.credits[token],
      }))
      : []
  );
  const feedback = <>
      {problem && (
        <div ref={errorSummary} className="p2p-feedback p2p-error" role="alert" tabIndex={-1}>
          <p>{problem.message}</p>
          <button
            className="p2p-button p2p-secondary"
            disabled={busy}
            onClick={() => registry ? void refresh() : setAttempt((value) => value + 1)}
          >
            {registry ? "Refresh contract data" : "Retry loading markets"}
          </button>
        </div>
      )}
      {session.account && registry && !networkMatches && (
        <p className="p2p-feedback" role="status">Switch to {registry.markets[0]?.chainName ?? "the market network"} in your wallet to manage P2P loans.</p>
      )}
      {session.error && <p className="p2p-feedback p2p-error" role="alert">{session.error}</p>}
      {notice && <p className="p2p-feedback" role="status">{notice}</p>}
      {account && <PendingRecovery key={account} account={account} markets={markets.map(item => item.config)} disabled={busy} onRecover={recoverSavedTransaction} />}
      {requestLinking && <p className="p2p-feedback" role="status">Offer funded. Confirm the wallet message to link it to the borrower request.</p>}
      {stage && (
        <div className="p2p-feedback p2p-transaction" role="status">
          <strong>{stage.message}</strong>
          {stage.hash && (
            <p>
              Transaction <span className="p2p-hash">{stage.hash}</span>
            </p>
          )}
          {pending && <p>Waiting for confirmation. A token approval alone does not open a loan.</p>}
        </div>
      )}
  </>;
  const content = (
    <div className="borrow-hub"><BorrowPageHeader active="p2p" />
    <section className="p2p-page p2p-wide-page dockyard-market-page borrow-selected-content" aria-label="P2P stock and memecoin loans">
      {tab !== "create" && feedback}
      {loading ? <div className="p2p-layout p2p-full-layout"><div className="p2p-workspace"><OfferListSkeleton /></div></div> : registry && (
        <>
          <div className="p2p-market-line">
            <span className="dockyard-market-chain">
              {markets[0]?.config.chainName ?? "P2P markets"}
            </span>
            <button className="p2p-reset p2p-refresh" aria-busy={reading}
              disabled={busy || reading} onClick={() => { setRequestRevision(value => value + 1); void refresh(); }}>
              <span aria-hidden={reading}>Refresh offers and balances</span>
              <span aria-hidden={!reading}>Refreshing…</span>
            </button>
          </div>
          <p className={`p2p-load-progress${!reading && !failures.length ? " p2p-visually-hidden" : ""}`} role="status" aria-label="Market loading status" data-p2p-loading={reading}>
            {newMarkets.some(item => item.reading)
              ? newMarkets.every(item => item.browse)
                ? "Updating markets in the background. Recent public offers remain visible."
                : `Loading markets · ${newMarkets.filter(item => item.browse && !item.error).length} of ${newMarkets.length} ready. Loaded markets are available now.`
              : `${newMarkets.filter(item => item.browse && !item.error).length} of ${newMarkets.length} markets ready${
                failures.filter(item => !isLegacy(item.config)).length ? ` · ${failures.filter(item => !isLegacy(item.config)).length} need a retry` : ""
              }.`}
          </p>
          {failures.length > 0 && (
            <div className="p2p-feedback p2p-market-failures">
              <p role="status">
                {failures.length} {failures.length === 1 ? "market needs" : "markets need"} a retry.
                {" "}Ready markets, loans and withdrawals remain available. Affected market actions stay disabled until refreshed.
              </p>
              <button className="p2p-reset" disabled={busy || failures.every((item) => item.reading)}
                onClick={() => void retryFailedMarkets()}>
                Retry failed markets
              </button>
              <details className="p2p-market-errors">
                <summary>Market error details</summary>
                {failures.map((item) => (
                <div className="p2p-market-read-error" key={item.config.address}>
                  <p>{item.config.collateralSymbol}{isLegacy(item.config) ? " pilot" : ""}: {item.error}</p>
                  <button
                    className="p2p-reset"
                    disabled={busy || item.reading}
                    onClick={() => void refresh(undefined, item.config.address)}
                  >
                    Retry {item.config.collateralSymbol}
                    {isLegacy(item.config) ? " pilot" : ""} market
                  </button>
                </div>
                ))}
              </details>
            </div>
          )}
          <div className="p2p-layout p2p-full-layout">
            <div className="p2p-workspace">
              <div className="p2p-workspace-navigation">
              <div className="p2p-tabs p2p-context-tabs" role="tablist" aria-label="P2P sections">
                {sections.map(([value, label], index) => (
                  <button
                    type="button"
                    role="tab"
                    id={`p2p-tab-${value}`}
                    aria-selected={tab === value || (tab === "create" && value === "marketplace")}
                    aria-controls="p2p-panel"
                    tabIndex={tab === value || (tab === "create" && value === "marketplace") ? 0 : -1}
                    key={value}
                    disabled={pending || negotiationBusy}
                    onClick={() => switchTab(value)}
                    onKeyDown={(event) => {
                      if (["ArrowRight", "ArrowLeft", "Home", "End"].includes(event.key)) {
                        event.preventDefault();
                        const next = event.key === "Home"
                          ? sections[0]
                          : event.key === "End"
                          ? sections[sections.length - 1]
                          : sections[(index + (event.key === "ArrowRight" ? 1 : sections.length - 1)) % sections.length];
                        switchTab(next![0]);
                        document.getElementById(`p2p-tab-${next![0]}`)?.focus();
                      }
                    }}
                  >
                    {label}
                  </button>
                ))}
              </div>
              </div>
              <div id="p2p-panel" className={currentOffer ? "p2p-focused-panel" : undefined} role="tabpanel" aria-labelledby={`p2p-tab-${tab === "create" ? "marketplace" : tab}`} aria-busy={busy}>
                <div hidden={!!currentOffer}>
                      {tab === "requests" && <BorrowerRequests onRequest={openRequest} onCreate={() => { switchTab("create"); }} key={`${account ?? "public"}:${requestMarket}`} refreshKey={requestRevision} initialMarket={requestMarket} intent="borrow" onConnect={() => void connectWallet()} markets={newMarkets.map(item => item.config)} account={account} provider={provider ?? null} disabled={busy} onFund={fundRequest} />}
                      {tab === "negotiations" && <Negotiations key={`${account ?? "public"}:${negotiationOffer ? offerKey(negotiationOffer) : "inbox"}`} markets={newMarkets.map(item => item.config)} account={account} provider={provider ?? null} sourceOffer={negotiationOffer} onBusyChange={setNegotiationBusy} disabled={connecting || pending || requestLinking} onConnect={() => void connectWallet()} onOpen={(market, id) => { const item = marketsRef.current.find(item => sameAddress(item.config.address, market.address)); if (item) void item.client.getLoan(id).then(loan => openOffer({ market, loan })).catch(cause => showError(failMessage(cause))); }} />}
                      {tab === "activity" && <P2PActivity account={account} markets={markets} refreshKey={stage?.status === "confirmed" ? stage.hash : undefined} />}
                      {tab === "alerts" && <><p className="p2p-alerts-notice">Automatic alerts are not active for PIPEDOG, TENDIES, HMM, IF, JUGGERNAUT or YOLO yet. Use the calendar reminders on your loans for these markets. Existing market alerts remain available.</p><P2PAlerts account={account} provider={provider} markets={markets.map(item => item.config)} scopeOverride={alertMarketScope} /></>}
                      {(tab === "marketplace" || tab === "create") && <BorrowerRequests
                        key={account ?? "public"} refreshKey={requestRevision} intent="lend"
                        markets={newMarkets.map(item => item.config)} account={account} provider={provider ?? null}
                        disabled={busy} onFund={fundRequest} onRequest={openRequest} onConnect={() => void connectWallet()}
                        renderBoard={board => <LoanMarketplace key={marketplaceVisit} board={board} offers={publicOffers}
                          markets={newMarkets.map(item => item.config)} account={account}
                          assetFilter={assetFilter} onAssetChange={setAssetFilter} onReview={openOffer}
                          onCreate={() => { switchTab("create"); }}
                          onRequest={() => openRequest(newMarkets.find(item => item.config.collateralSymbol === assetFilter)?.config.address ?? "")}
                          hasMore={hasPublicMore} loading={publicPending}
                          failed={failures.some(item => !isLegacy(item.config))}
                          loadMoreDisabled={busy || reading} onLoadMore={() => void refresh("public")} />}
                      />}
                </div>
                {currentOffer
                  ? (
                    <>
                      <button className="p2p-reset p2p-back" disabled={pending || negotiationBusy} onClick={() => choose(null)}>
                        Back to {tab === "loans" ? "my loans" : tab === "negotiations" ? "negotiations" : "marketplace"}
                      </button>
                      {loanCard(currentOffer, true)}
                      {currentOffer.market.version === 3 && !currentOffer.market.legacy && currentOffer.loan.status === "open" && currentOffer.loan.expiresAt > Date.now() / 1000 && (!account || !sameAddress(currentOffer.loan.lender, account)) && <div className="p2p-negotiate-entry"><h3>Need different terms?</h3><p>Propose an amount, repayment or duration to the lender. The original offer remains available until it is cancelled.</p><button className="p2p-button p2p-secondary" disabled={busy} onClick={() => { const offer = currentOffer; switchTab("negotiations"); setNegotiationOffer(offer); }}>Propose different terms</button></div>}
                    </>
                  )
                  : (
                    <>
                      {tab === "create" && (
                        <LoanActionDialog title="Lend USDG" closeLabel="Close lending offer" busy={busy} onClose={() => { if (!operation.current) switchTab("marketplace"); }}>
                          {feedback}
                          {!newMarkets.length
                            ? (
                              <EmptyState heading="h2" title="New lending offers are unavailable" illustration={false} description="You can still manage existing loans and withdraw available credits." actions={<button className="p2p-button" onClick={() => switchTab("loans")}>View my loans</button>} />
                            )
                            : !account
                            ? (
                              <><p>You supply the USDG. A borrower locks their tokens and receives your money. They must repay you plus the interest you choose.</p><p className="p2p-help">Funding reserves your USDG in the contract. You can cancel before a borrower accepts. After acceptance, if they miss the final repayment deadline, you can claim their tokens; those tokens may be worth less than you lent.</p><button className="p2p-button" disabled={busy} onClick={() => { setTab("marketplace"); setResumeCreate(true); void connectWallet(); }}>Connect wallet to lend</button></>
                            )
                            : draft
                            ? (
                              <div className="p2p-create">
                                <h2 id="p2p-review-heading" ref={reviewHeading} tabIndex={-1}>{directFunding ? "Fund your proposal" : "Review your offer"}</h2>
                                {directFunding ? <>
                                  <p>Your proposal is saved. Continue in your wallet to approve USDG if needed, deposit it, and link the funded offer. The borrower must accept before the loan starts.</p>
                                  <TermsSummary market={draft.market} terms={{ principal: draft.terms.principal.toString(), collateral: draft.terms.collateral.toString(), interest: draft.terms.interest.toString(), durationDays: draft.terms.durationDays, expiresAt: draft.terms.expiresAt }} />
                                  <p className="p2p-help">If you stop here, your proposal stays published. If you submitted a transaction, check its confirmation before retrying.</p>
                                  <button className="p2p-button" disabled={busy || !!creationReason} onClick={() => void fundOffer()}>Continue funding</button>
                                  {creationReason && <p className="p2p-help">{creationReason}</p>}
                                  <button className="p2p-reset" disabled={busy} onClick={() => switchTab("marketplace")}>Back to marketplace</button>
                                </> : <>
                                <p>
                                  {sameAddress(draft.terms.borrower, ZERO_ADDRESS)
                                    ? "Public · Any eligible wallet can accept."
                                    : `Private · Only ${draft.terms.borrower} can accept.`}
                                </p>
                                <p className="p2p-review-funding"><strong>You are lending, not borrowing.</strong> Funding sends your USDG to the contract. A borrower supplies the collateral and receives your USDG only when they accept.</p>
                                <Exchange
                                  lender
                                  principal={loanAmount(draft.terms.principal, draft.market)}
                                  collateral={collateralAmount(draft.terms.collateral, draft.market)}
                                  symbol={draft.market.collateralSymbol}
                                />
                                <dl className="p2p-cost">
                                  <div>
                                    <dt><TermLabel topic="interest" helpLabel="Interest for this loan">Interest for this loan</TermLabel></dt>
                                    <dd>{loanAmount(draft.terms.interest, draft.market)} · {termPercent(draft.terms.principal, draft.terms.interest)} for the full term</dd>
                                  </div>
                                  <div className="p2p-total">
                                    <dt><TermLabel topic="repayment" helpLabel="Total repayment">Total repayment</TermLabel></dt>
                                    <dd>{loanAmount(draft.terms.principal + draft.terms.interest, draft.market)}</dd>
                                  </div>
                                </dl>
                                <p className="p2p-help">
                                  {draft.terms.durationDays}{" "}
                                  days from acceptance, then a 24-hour grace period. Offer expires{" "}
                                  {displayDate(draft.terms.expiresAt)}.
                                </p>
                                <p className="p2p-review-funding">
                                  You deposit {loanAmount(draft.terms.principal, draft.market)}{" "}
                                  when publishing. It is reserved until acceptance, cancellation or expiry. Open offers
                                  earn no interest.
                                </p>
                                <CollateralMarketPrice market={draft.market} amount={formatAmount(draft.terms.collateral, draft.market.collateralDecimals)} />
                                {requestFunding && <p className="p2p-help">Funding this private offer responds to the selected borrower request. After funding, confirm one message signature to link the offer. The borrower must still accept the loan.</p>}
                                {draft.market.version === 3 && <V3CustodyNotice />}
                                <label className="p2p-check">
                                  <input
                                    type="checkbox"
                                    checked={lenderRisk}
                                    disabled={busy}
                                    onChange={(event) => setLenderRisk(event.target.checked)}
                                  />
                                  <span>
                                    I accept that my funds remain locked through an active loan. If the final deadline
                                    is missed, I receive {draft.market.version === 3 ? "the remaining collateral" : "all collateral"}, which may be worth less than my principal.
                                    Repayment and returns are not guaranteed.
                                  </span>
                                </label>
                                <button
                                  className="p2p-button"
                                  disabled={busy || !!creationReason || !lenderRisk}
                                  onClick={() => void fundOffer()}
                                >
                                  Fund offer
                                </button>
                                {(creationReason || !lenderRisk) && (
                                  <p className="p2p-help">
                                    {creationReason || "Acknowledge the lender risk to fund your offer."}
                                  </p>
                                )}
                                <button
                                  className="p2p-reset"
                                  disabled={pending || negotiationBusy}
                                  onClick={() => {
                                    setDraft(null);
                                    setRequestFunding(null);
                                    setLenderRisk(false);
                                  }}
                                >
                                  Edit terms
                                </button>
                                </>}
                              </div>
                            )
                            : (
                              <form className="p2p-create" ref={offerForm} onSubmit={reviewOffer} noValidate>
                                <p>
                                  You supply the USDG. Choose how much to lend, which tokens the borrower must lock, and the interest they must repay. You’ll review everything before moving funds.
                                </p>
                                <fieldset disabled={busy}>
                                  <legend className="p2p-visually-hidden">Loan terms</legend>
                                  <div className="turret-labeled-field"><FieldLabel htmlFor="p2p-field-visibility" topic="visibility" helpLabel="Offer visibility">Offer visibility</FieldLabel>
                                    <select
                                      id="p2p-field-visibility" name="visibility"
                                      value={visibility}
                                      onChange={(event) => { setVisibility(event.target.value); clearFieldErrors("borrower"); }}
                                    >
                                      <option value="public">Public · Anyone can borrow</option>
                                      <option value="private">Private · Specific wallet</option>
                                    </select>
                                  </div>
                                  <p className="p2p-help">
                                    {visibility === "public"
                                      ? "Anyone with the required collateral can accept. No borrower address is needed."
                                      : "Only the specified wallet can accept. The terms remain visible on-chain."}
                                  </p>
                                  {visibility === "private" && (
                                    <>
                                    <label className="p2p-field-block" htmlFor="p2p-field-borrower">
                                      Borrower wallet address<input
                                        id="p2p-field-borrower" name="borrower"
                                        value={borrower}
                                        onChange={(event) => { setBorrower(event.target.value); clearFieldErrors("borrower"); }}
                                        aria-invalid={!!formErrors.borrower}
                                        aria-describedby={formErrors.borrower ? "p2p-error-borrower" : undefined}
                                        spellCheck={false}
                                        autoCapitalize="none"
                                        autoComplete="off"
                                      />
                                    </label>
                                    {formErrors.borrower && <p className="p2p-field-error" id="p2p-error-borrower">{formErrors.borrower}</p>}
                                    </>
                                  )}
                                  <CollateralPicker
                                    assets={newMarkets.map((item) => item.config)}
                                    value={createMarket}
                                    onChange={(value) => {
                                      setCreateMarket(value as Address);
                                      clearFieldErrors("principal", "collateral", "interest");
                                    }}
                                  />
                                  {activeMarket && (
                                    <p className="p2p-help p2p-token-identity">
                                      {activeMarket.config.collateralName ?? activeMarket.config.collateralSymbol} ·
                                      {" "}
                                      {activeMarket.config.chainName}
                                      <span className="p2p-address">{activeMarket.config.collateralToken}</span>
                                      Collateral is measured in token units.
                                    </p>
                                  )}
                                  <CollateralControls
                                    key={createMarket}
                                    principal={principal}
                                    collateral={collateral}
                                    interest={interest}
                                    symbol={activeMarket?.config.collateralSymbol ?? "Token"}
                                    loanDecimals={activeMarket?.config.loanDecimals ?? 6}
                                    collateralDecimals={activeMarket?.config.collateralDecimals ?? 18}
                                    errors={formErrors}
                                    onPrincipal={(value) => { setPrincipal(value); clearFieldErrors("principal", "interest"); }}
                                    onCollateral={(value) => { setCollateral(value); clearFieldErrors("collateral"); }}
                                  />
                                  <LoanInterestField
                                    model={interestModel}
                                    inputId="p2p-field-interest"
                                    duration={duration}
                                    decimals={activeMarket?.config.loanDecimals ?? 6}
                                    error={formErrors.interest}
                                    onChange={() => clearFieldErrors("interest")}
                                  />
                                  {activeMarket && <CollateralMarketPrice market={activeMarket.config} amount={collateral} />}
                                  <div className="turret-labeled-field"><FieldLabel htmlFor="p2p-field-duration" topic="duration" helpLabel="Loan duration · days">Loan duration · days</FieldLabel>
                                    <input
                                      id="p2p-field-duration" name="duration"
                                      inputMode="numeric"
                                      value={duration}
                                      onChange={(event) => { setDuration(event.target.value); clearFieldErrors("duration", "expiry"); }}
                                      aria-invalid={!!formErrors.duration}
                                      aria-describedby={`p2p-duration-help${formErrors.duration ? " p2p-error-duration" : ""}`}
                                    />
                                  </div>
                                  {formErrors.duration && <p className="p2p-field-error" id="p2p-error-duration">{formErrors.duration}</p>}
                                  <div className="p2p-duration-presets" aria-label="Duration presets">
                                    {[7, 14, 30, 90].map((days) => (
                                      <button
                                        type="button"
                                        key={days}
                                        aria-pressed={duration === String(days)}
                                        onClick={() => { setDuration(String(days)); clearFieldErrors("duration", "expiry"); }}
                                      >
                                        {days} days
                                      </button>
                                    ))}
                                  </div>
                                  <p className="p2p-help" id="p2p-duration-help">
                                    Use a preset or enter any positive whole number of days. A 24-hour grace period
                                    follows.
                                  </p>
                                  <div className="turret-labeled-field"><FieldLabel htmlFor="p2p-field-expiry" topic="expiry" helpLabel="Offer expiry · local time">Offer expiry · local time</FieldLabel>
                                    <input
                                      id="p2p-field-expiry" name="expiry"
                                      type="datetime-local"
                                      value={expiry}
                                      onChange={(event) => { setExpiry(event.target.value); clearFieldErrors("expiry"); }}
                                      aria-invalid={!!formErrors.expiry}
                                      aria-describedby={`p2p-expiry-help${formErrors.expiry ? " p2p-error-expiry" : ""}`}
                                    />
                                  </div>
                                  {formErrors.expiry && <p className="p2p-field-error" id="p2p-error-expiry">{formErrors.expiry}</p>}
                                  <p className="p2p-help" id="p2p-expiry-help">
                                    Expiry is the last time this offer can be accepted. It does not shorten an accepted
                                    loan.
                                  </p>
                                  <div className="p2p-live-summary">
                                    <Exchange
                                      principal={draftPrincipal}
                                      collateral={draftCollateral}
                                      symbol={activeMarket?.config.collateralSymbol ?? "Token"}
                                    />
                                    <div className="p2p-repayment-total">
                                      <span>Total repayment</span>
                                      <strong>{draftTotal}</strong>
                                    </div>
                                  </div>
                                  {Object.keys(formErrors).length > 0 && <p className="p2p-field-error" role="alert">Check the highlighted loan terms.</p>}
                                  <button className="p2p-button" id="p2p-review-submit" ref={reviewSubmit} type="submit" disabled={!!creationReason}>
                                    Review offer
                                  </button>
                                </fieldset>
                                {creationReason && <p className="p2p-help">{creationReason}</p>}
                              </form>
                            )}
                        </LoanActionDialog>
                      )}
                      {tab === "loans" && (
                        <>
                          {created && (
                            <div className="p2p-published">
                              <h2>Your offer is published</h2>
                              <p>
                                {created.loan.isPublic
                                  ? "Borrowers can now find it in the marketplace."
                                  : "Share the link with your intended borrower."}
                              </p>
                              <div className="p2p-action-row">
                                <button className="p2p-button" onClick={() => openOffer(created)}>View offer</button>
                                <button className="p2p-button p2p-secondary" onClick={() => void copyLink(created)}>
                                  Copy link
                                </button>
                              </div>
                              <button className="p2p-reset" onClick={() => switchTab("create")}>
                                Create another offer
                              </button>
                            </div>
                          )}
                          {!account
                            ? (
                              <EmptyState heading="h2" title="Your loans, offers and credits" description="Connect the wallet you used to borrow or lend. Your current and earlier loans will appear here." actions={<button className="p2p-button" disabled={busy} onClick={() => void connectWallet()}>Connect wallet to view loans</button>} />
                            )
                            : (
                              <>
                                <p className="p2p-help">Borrowing: you receive USDG and owe repayment. Lending: you supply USDG and the borrower owes repayment. Incoming: an offer for you that you have not accepted. History: loans and offers that have ended.</p>
                                <div className="p2p-personal-tabs" aria-label="Your loan views">
                                  {(["borrowing", "lending", "history", ...(markets.some(item => item.config.version === 3) ? ["incoming"] : [])] as PersonalTab[]).map((value) => (
                                    <button
                                      key={value}
                                      aria-pressed={personalTab === value}
                                      onClick={() => setPersonalTab(value)}
                                    >
                                      {value[0]!.toUpperCase() + value.slice(1)}
                                    </button>
                                  ))}
                                </div>
                                {markets.some(item => item.own?.activeLoansComplete === false) && <p role="status" className="p2p-help">
                                  Active-loan discovery is still updating for some markets. Known loans remain below; use a loan link or ID if a payment is due.
                                </p>}
                                {personalTab === "incoming" && <p className="p2p-help">Private offers addressed to your wallet. An invitation is not a loan; no collateral is locked until you accept.</p>}
                                {personalTab === "incoming" && markets.some(item => item.own?.incomingOffersMessage) && <p className="p2p-help" role="status">Some incoming offers could not be loaded. Existing loans remain available in Borrowing and Lending.</p>}
                                {currentPersonal.length
                                  ? currentPersonal.map((offer) => loanCard(offer))
                                  : (
                                    ownPending ? <p role="status">Loading your loans…</p> : <EmptyState heading="h2"
                                      illustration={!failures.length}
                                      title={failures.length ? "Some loans could not be loaded"
                                        : personalTab === "incoming" ? "No offers addressed to you in these results"
                                        : personalTab === "history" ? "No completed loans in these results"
                                        : personalTab === "lending" ? "No lending offers in these results"
                                        : "No borrowing loans in these results"}
                                      description={failures.length ? "Retry the affected markets above. A failed check does not mean you have no loans."
                                        : hasOwnMore ? "Earlier loans haven’t been checked yet. Load older loans below to continue."
                                        : personalTab === "borrowing" ? "Choose an offer to borrow USDG against your tokens, or request the terms you need."
                                        : personalTab === "incoming" ? "Offers a lender addresses to this wallet appear here. You can also browse public offers."
                                        : personalTab === "history" ? "Repaid, cancelled and settled loans appear here after they end."
                                        : "Choose your collateral and repayment terms, then deposit USDG to make an offer available to a borrower."}
                                      actions={!failures.length && !hasOwnMore && <button className="p2p-button" disabled={busy} onClick={() => { switchTab(personalTab === "lending" ? "create" : "marketplace"); }}>{personalTab === "lending" ? "Create a lending offer" : "Browse lending offers"}</button>}
                                    />
                                  )}
                                {personalTab !== "incoming" && hasOwnMore && (
                                  <button
                                    className="p2p-button p2p-secondary"
                                    disabled={busy || reading}
                                    onClick={() => void refresh("own")}
                                  >
                                    Load older loans
                                  </button>
                                )}
                                {personalTab === "incoming" && markets.some(item => item.own?.incomingNextCursor != null || item.own?.incomingOffersMessage) && <button className="p2p-button p2p-secondary" disabled={busy || reading} onClick={() => void loadIncoming()}>Load more incoming offers</button>}
                              </>
                            )}
                          <LoanRecovery markets={markets.map(item => item.config)} busy={busy} open={async (config, id) => {
                            const item = marketsRef.current.find(item => sameAddress(item.config.address, config.address));
                            if (!item) throw new Error("Market unavailable");
                            const loan = await item.client.getLoan(id);
                            choose({ market: config, loan });
                            return loan;
                          }} />
                        </>
                      )}
                    </>
                  )}
                {tab === "credits" && !currentOffer && (
                  <div className="p2p-funds-layout">
              <section className="p2p-credits" id="p2p-credits">
                <h2>Available to withdraw</h2>
                <p>Money returned from cancelled offers or settled loans waits here until you withdraw it to your wallet. Checking these balances does not move money or cost gas.</p>
                <p>Your open offers and active loans are not available to withdraw. To recover an unaccepted offer’s funds, cancel that offer first.</p>
                {account && (() => {
                  const checks = markets.filter(item => item.config.version === 3).map(item => ({
                    item, discovery: withdrawalDiscovery.entries[item.config.address.toLowerCase()],
                  }));
                  const complete = checks.filter(({ discovery }) => discovery?.complete).length;
                  const pending = checks.some(({ item, discovery }) => discovery?.loading || (!discovery && !item.error));
                  const failed = checks.filter(({ item, discovery }) => discovery?.error || item.error);
                  const more = checks.some(({ discovery }) => discovery?.more);
                  return <div className="p2p-help">
                    <p role="status">{pending
                      ? `Checking for money you can withdraw · ${complete} of ${checks.length} markets checked.`
                      : failed.length || more
                      ? `Balance check incomplete · ${complete} of ${checks.length} markets checked.`
                      : "Balance check complete."}</p>
                    {(failed.length > 0 || more) && <>
                      <p>Amounts already found remain listed below. Unchecked markets may have additional funds.</p>
                      <details><summary>See which markets need attention</summary>
                        {checks.filter(({ item, discovery }) => discovery?.error || discovery?.more || item.error).map(({ item, discovery }) =>
                          <p key={item.config.address}>{item.config.collateralSymbol}: {discovery?.error || item.error || "More loan history remains to be checked."}</p>)}
                      </details>
                      {failed.length > 0 && <button className="p2p-button p2p-secondary" disabled={busy || reading} onClick={() => { withdrawalDiscovery.retry(); void refresh(); }}>Retry balance check</button>}
                      {more && <button className="p2p-button p2p-secondary" disabled={busy} onClick={withdrawalDiscovery.loadMore}>Check older loans</button>}
                    </>}
                  </div>;
                })()}
                {account
                  ? (
                    <>
                      {(credits.length + v3Credits.length)
                        ? (
                          <>
                            <label className="p2p-field-block" htmlFor="p2p-withdrawal-recipient">
                              Withdrawal recipient<input
                                id="p2p-withdrawal-recipient"
                                value={recipient}
                                disabled={busy}
                                onChange={(event) => setRecipient(event.target.value)}
                                spellCheck={false}
                                autoCapitalize="none"
                              />
                            </label>
                            {v3Credits.map(({ item, loan, token }) => <V3LoanCredit
                              key={`${item.config.address}:${loan.id}:${token}`} market={item.config} loan={loan} token={token}
                              account={account} recipient={recipient} disabled={!canWrite(item)}
                              run={(action, success) => { void transact(item, action, success); }}
                            />)}

                            {credits.map(({ item, token, amount }) => (
                              <div className="p2p-credit" key={`${item.config.address}:${token}`}>
                                <p>
                                  <strong>
                                    {token === "USDG"
                                      ? loanAmount(amount, item.config)
                                      : collateralAmount(amount, item.config)}
                                  </strong>
                                  <span>
                                    {item.config.collateralSymbol} {isLegacy(item.config) ? "original pilot" : "market"}
                                  </span>
                                </p>
                                <button
                                  className="p2p-button p2p-secondary"
                                  disabled={!canWrite(item)}
                                  onClick={() => {
                                    if (
                                      !validAddress(recipient)
                                      || markets.some((market) =>
                                        sameAddress(market.config.address, recipient)
                                      )
                                    ) {
                                      showError(
                                        "Enter a valid withdrawal recipient different from the lending contracts.",
                                      );
                                      return;
                                    }
                                    void transact(
                                      item,
                                      (client, wallet, onStage) =>
                                        client.withdraw(wallet, token, amount, recipient, onStage),
                                      `Funds withdrawn to ${shortAddress(recipient)}.`,
                                    );
                                  }}
                                >
                                  Withdraw {token === "USDG" ? "USDG" : item.config.collateralSymbol}
                                  {isLegacy(item.config) ? " · pilot" : ""}
                                </button>
                                {readonlyReason(item) && <p className="p2p-help">{readonlyReason(item)}</p>}
                              </div>
                            ))}
                          </>
                        )
                        : (
                          <p className="p2p-help">
                            {ownPending
                              ? "Checking your loan balances. Any available funds will appear here."
                              : failures.length
                              ? "Some credits could not be loaded. Refresh before relying on these balances."
                              : markets.some(item => item.config.version === 3 && !withdrawalDiscovery.entries[item.config.address.toLowerCase()]?.complete)
                              ? "No withdrawable funds found yet. The balance check is incomplete."
                              : "You have no funds waiting to be withdrawn. Money reserved in open offers or lent through active loans stays with those loans."}
                          </p>
                        )}
                    </>
                  )
                  : <>
                    <p className="p2p-help">Connect your wallet to view credits, including original pilot funds.</p>
                    <button className="p2p-button" disabled={busy || !markets.length} onClick={() => void connectWallet()}>Connect wallet to view withdrawals</button>
                  </>}
              </section>
                    {account && (
                      <div className="p2p-wallet-details">
              <section className="p2p-wallet" id="p2p-wallet" tabIndex={-1}>
                <h2>Wallet balances</h2>
                    <>
                      <p className="p2p-address">{account}</p>
                      {connectedData
                        ? (
                          <>
                            <dl className="p2p-balances">
                              <div>
                                <dt>USDG</dt>
                                <dd>{connectedData.balancesUnavailable?.USDG ? "Unavailable" : formatAmount(connectedData.balances.USDG, 6)}</dd>
                              </div>
                              {balances.map((item) => (
                                <div key={item.config.collateralToken}>
                                  <dt>{item.config.collateralSymbol}</dt>
                                  <dd>{item.own!.balancesUnavailable?.COLLATERAL ? "Unavailable" : formatAmount(item.own!.balances.COLLATERAL, item.config.collateralDecimals)}</dd>
                                </div>
                              ))}
                            </dl>
                            <p className="p2p-help">
                              Last read{" "}
                              {displayDate(connectedData.now)}. Wallet balances are separate from reserved funding.
                            </p>
                          </>
                        )
                        : (
                          <p>
                            {ownPending
                              ? "Loading your wallet balances…"
                              : "Unable to load wallet balances. Refresh to try again."}
                          </p>
                        )}
                      {ownPending && connectedData && (
                        <p className="p2p-help">
                          Balances from loaded markets are shown. Other markets are still loading.
                        </p>
                      )}
                      <button
                        className="p2p-button p2p-secondary"
                        disabled={busy || reading}
                        onClick={() => void refresh()}
                      >
                        Refresh balances and loans
                      </button>
                      <button className="p2p-reset" disabled={busy} onClick={() => disconnect()}>Disconnect</button>
                    </>

              </section>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>

          </div>
          <details className="p2p-guidance">
            <summary>How P2P loans work and collateral risk</summary>
            <div className="p2p-guidance-content">
              <section>
                <h2>Fixed terms, collateral risk</h2>
                <p>Repay the full agreed amount by the final deadline to recover your collateral. There is no price-triggered sale.</p>
                <p>Miss the deadline and all collateral goes to the lender. Its value may be higher or lower than the debt. USDG recovery and returns are not guaranteed.</p>
                <p>Token restrictions and network outages do not stop the repayment clock. New-loan pauses do not extend existing loans. Repay early and keep your loan link.</p>
                <p>For lenders, an open offer keeps its original terms even if collateral loses value. Use an expiry you can monitor, and cancel or replace offers when your terms change.</p>
              </section>
              {markets.some((item) => isLegacy(item.config)) && <p>Original SLV pilot loans keep their agreed terms and remain accessible in My loans. Settled credits are in Withdrawals.</p>}
              {registry.unavailableAssets.length > 0 && (
                <details className="p2p-controls">
                  <summary>Unavailable collateral</summary>
                  {registry.unavailableAssets.map((asset) => (
                    <div key={asset.address} className="p2p-unavailable-asset">
                      <strong>{asset.symbol} · {asset.name}</strong><p>{asset.reason}</p>
                      <span className="p2p-address">{asset.address}</span>
                    </div>
                  ))}
                </details>
              )}
            </div>
          </details>
          <footer className="p2p-footer">
            P2P loans use each lender’s reserved funds and are separate from pooled Borrow and Earn. Token transfers may
            be affected by issuer restrictions. Open offers earn no interest.
          </footer>
        </>
      )}
      {requestOpen && <RequestLoanDialog markets={newMarkets.map(item => item.config)} initialMarket={requestMarket} account={account} provider={provider ?? null} disabled={busy}
        onClose={() => setRequestOpen(false)} onConnect={() => { setRequestOpen(false); setResumeRequest(true); void connectWallet(); }}
        onPublished={() => setRequestRevision(value => value + 1)} onViewRequests={() => { setRequestOpen(false); setMarketplaceVisit(value => value + 1); setAssetFilter(""); switchTab("marketplace"); }} />}
    </section></div>
  );
  if (!standalone) return content;
  return <P2PAppLayout network={markets[0]?.config.chainName ?? "Robinhood"} wallet={<AccountButton />}>{content}</P2PAppLayout>;
}
