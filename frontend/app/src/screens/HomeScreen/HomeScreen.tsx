"use client";

import type { BranchId, CollateralSymbol } from "@/src/types";

import { HowBorrowingWorks } from "@/src/comps/HowBorrowingWorks/HowBorrowingWorks";
import { READ_ONLY_DEPLOYMENT } from "@/src/deployment-config";
import { DOCKYARD_STANDALONE_DEPLOYMENT, getDockyardMarket } from "@/src/dockyard-config";
import { ISOLATED_MARKETS, type IsolatedMarket } from "@/src/isolated-market-config";
import { getIsolatedAsset } from "@/src/isolated-assets";
import { getBranches, getCollToken } from "@/src/liquity-utils";
import { DeferredMarkets } from "@/src/screens/IsolatedMarketScreen/DeferredMarkets";
import {
  fetchStockMarketAvailability,
  marketCountdown,
  type StockMarketAvailability,
} from "@/src/stock-market-availability";
import Link from "next/link";
import { type ReactNode, useEffect, useRef, useState } from "react";

const MARKET_ROTATION_INTERVAL_MS = 2800;
const MARKET_STATUS_REFRESH_INTERVAL_MS = 30_000;

const MVP_MARKETS = [
  { symbol: "AAPL", name: "Apple", maxLtv: "52.1%", liquidationLtv: "57.1%" },
  { symbol: "MSFT", name: "Microsoft", maxLtv: "52.1%", liquidationLtv: "57.1%" },
  { symbol: "GOOGL", name: "Alphabet", maxLtv: "50.6%", liquidationLtv: "55.6%" },
  { symbol: "AMZN", name: "Amazon", maxLtv: "49.1%", liquidationLtv: "54.1%" },
  { symbol: "META", name: "Meta Platforms", maxLtv: "47.6%", liquidationLtv: "52.6%" },
  { symbol: "NVDA", name: "Nvidia", maxLtv: "45%", liquidationLtv: "50%" },
  { symbol: "AMD", name: "Advanced Micro Devices", maxLtv: "45%", liquidationLtv: "50%" },
  { symbol: "ORCL", name: "Oracle", maxLtv: "45%", liquidationLtv: "50%" },
  { symbol: "MU", name: "Micron", maxLtv: "39.4%", liquidationLtv: "44.4%" },
  { symbol: "TSLA", name: "Tesla", maxLtv: "35%", liquidationLtv: "40%" },
] as const;

const CONFIGURED_PREVIEW_MARKETS = MVP_MARKETS.filter(({ symbol }) =>
  ISOLATED_MARKETS.some((market) => market.symbol === symbol)
);

const FAQ_ITEMS = [
  {
    question: "What can I do with Turret?",
    answer: [
      "Borrow USDG against your Stock Tokens on Robinhood Chain. You deposit a supported token as collateral and receive USDG in your wallet without selling the token.",
      "Your Stock Token stays locked while you owe USDG. You remain exposed to its price: you benefit if it rises, but a large enough fall can trigger liquidation and cost you some or all of your collateral.",
    ],
  },
  {
    question: "What do I need to get started?",
    answer: [
      "A wallet connected to Robinhood Chain, a supported Stock Token in that wallet, and ETH on Robinhood Chain to pay network fees. Choose from the ten tokens listed in Markets.",
      "You will need USDG to repay the loan, including the borrowing fee, and ETH for the repayment transaction.",
    ],
  },
  {
    question: "Where does the USDG come from?",
    answer: [
      "Turret lends existing USDG supplied to the vault by its owner. It does not create a new stablecoin or mint USDG when you borrow.",
      "The borrowing screen shows how much USDG is available. Your loan cannot exceed that amount, even if your collateral would support a larger loan.",
    ],
  },
  {
    question: "How do I open a loan?",
    answer: [
      "Choose a Stock Token, connect your wallet, and enter how much collateral to deposit and how much USDG to borrow. Review the fee and loan-to-value ratio, then approve the collateral token if prompted.",
      "Select Deposit and borrow USDG and confirm in your wallet. The deposit and loan happen in one transaction: either both succeed, or neither does. If borrowing fails, that transaction does not leave your collateral locked in the vault. Network fees may still apply.",
    ],
  },
  {
    question: "How do I get my Stock Tokens back?",
    answer: [
      "Open the same market with the wallet that holds your position. Your position shows the full USDG debt, including the borrowing fee. Approve USDG repayment if prompted, then select Repay and reclaim to return the debt and receive all remaining collateral in one transaction.",
      "This full-repayment exit does not need a price feed and remains available when Turret pauses borrowing or disables a market. It still requires enough USDG and ETH in your wallet, and the underlying tokens must allow transfers.",
    ],
  },
  {
    question: "What is LTV?",
    answer: [
      "LTV means loan-to-value: your USDG debt divided by the current dollar value of your collateral. For example, $400 of debt against $1,000 of Stock Tokens is a 40% LTV.",
      "Your LTV rises if the Stock Token price falls or you borrow more. It falls if the token price rises, you add collateral, or you repay debt.",
    ],
  },
  {
    question: "How much can I borrow before risking liquidation?",
    answer: [
      "Each token has two limits. The borrowing limit is the highest LTV allowed when you take out a loan. The liquidation level is the point above which your collateral can be taken to repay the debt. The borrowing limit sits five percentage points below the liquidation level.",
      "For AAPL, these levels are approximately 52.1% and 57.1%. Other tokens have different limits, shown on the borrowing screen. Borrowing less leaves more room for a price fall, but no loan amount is free of liquidation risk.",
    ],
  },
  {
    question: "What does borrowing cost?",
    answer: [
      "A one-time 0.5% fee is added to each amount you borrow. Borrow 100 USDG and you receive 100 USDG, with 100.50 USDG to repay. The fee counts toward your LTV.",
      "There is no ongoing interest or scheduled repayment date. Your position must still stay below its liquidation level. You also pay network fees in ETH for transactions; review the fee and debt shown before confirming.",
    ],
  },
  {
    question: "How do liquidations work?",
    answer: [
      "If your LTV exceeds the market’s liquidation level, another participant can repay some or all of your USDG debt and receive collateral in return. The collateral includes a 5% liquidation bonus, so you lose more collateral value than the amount of debt repaid.",
      "Liquidation can be partial or complete. Any remaining debt and collateral stay in your position; a severe price fall can leave you with no collateral. If collateral is exhausted with debt still outstanding, the owner can write off that shortfall, leaving a loss in the vault. Liquidation is not guaranteed to happen before a loss occurs.",
    ],
  },
  {
    question: "How does Turret decide the Stock Token price?",
    answer: [
      "Turret reads two price feeds for each Stock Token. If both are valid and within 2% of each other, it uses the lower price. If only one is valid, it can use that feed. Prices 24 hours old or older are rejected.",
      "If neither feed is valid, they disagree too much, or the Stock Token reports an oracle pause, actions that need a price check stop. These checks reduce the chance of lending against a bad price, but cannot eliminate oracle risk.",
    ],
  },
  {
    question: "What happens when the stock market is closed or a token is paused?",
    answer: [
      "Market hours alone do not determine whether you can borrow. Turret relies on valid price data and the Stock Token’s oracle status. When those checks fail, new deposits, borrowing, liquidations, and collateral withdrawals that need a safety check are blocked.",
      "You can still repay your debt. Full repayment lets you reclaim your remaining collateral without a price check, provided the token itself allows the transfer. Price gaps when markets reopen can increase liquidation risk.",
    ],
  },
  {
    question: "Can I deposit USDG to earn yield?",
    answer: [
      "No. Turret does not offer public USDG deposits or an Earn account. Lending liquidity is supplied by the vault owner; there are no depositor shares or public yield claims.",
      "Do not transfer USDG directly to the vault expecting an account balance, interest, or a withdrawal right. To repay a loan, use the repayment action on your position.",
    ],
  },
  {
    question: "Are the Stock Token markets connected?",
    answer: [
      "Your collateral and debt are tracked separately for each Stock Token. AAPL collateral does not support an NVDA loan, and each market has its own price feeds, LTV limits, and cap on total debt.",
      "The markets share one USDG balance. Loans in one market reduce the USDG available to borrow elsewhere, and losses from unpaid debt affect the same vault. Separate collateral positions do not mean separate liquidity pools.",
    ],
  },
  {
    question: "What control does the vault owner have?",
    answer: [
      "The vault is managed by a single owner wallet. It can pause new borrowing, enable or disable markets, add supported markets, change market debt caps, and withdraw unborrowed USDG. It can also write off debt after a position has no collateral left.",
      "These controls can change borrowing availability. They do not allow the owner to withdraw a borrower’s Stock Token collateral directly or turn off full repayment through Turret’s pause controls. You still rely on the owner wallet being managed securely.",
    ],
  },
  {
    question: "What are the main risks?",
    answer: [
      "You can lose funds through liquidation, smart-contract bugs, incorrect prices, token transfer restrictions, corporate actions, or a compromised owner wallet. USDG can also trade away from its intended dollar value. A Stock Token is not the same as holding a share in a brokerage account.",
      "The contracts have not completed an independent security audit. Testing does not guarantee safety, and losses may be permanent. Understand the token terms, your loan’s limits, and these risks before depositing collateral.",
    ],
  },
] as const;

const POOL_FAQ_ITEMS = [
  {
    question: "Which markets can I use?",
    answer: [
      "The table lists the configured Stock Token markets. A market marked ‘Not open yet’ is still undergoing final checks; new deposits and borrowing are unavailable.",
      "Connect your wallet on Robinhood Chain to view an existing position. You need ETH for network fees and USDG to repay debt.",
    ],
  },
  {
    question: "What does borrowing cost?",
    answer: [
      "Debt accrues interest at the borrower APR shown in the market. Review your debt, interest rate and transaction details before confirming in your wallet.",
      "Repaying sooner reduces the time interest accrues. Wallet approvals and loan transactions are separate steps, and network fees are paid in ETH.",
    ],
  },
  {
    question: "How do I manage liquidation risk?",
    answer: [
      "Your loan-to-value ratio compares debt with the current value of your collateral. The loan screen shows your current LTV and the market’s liquidation threshold.",
      "If your position becomes eligible, collateral can be liquidated to repay debt. Repaying USDG or adding collateral lowers LTV. Price gaps can leave little or no time to act; email warnings are not a guarantee.",
    ],
  },
  {
    question: "Can I repay when borrowing is paused?",
    answer: [
      "Repayment remains available for review when new borrowing is paused. The transaction still needs a working chain connection, sufficient USDG and ETH, and tokens that allow transfers.",
      "Use the market’s repayment controls. After clearing the debt, review a withdrawal of your remaining collateral. Sending tokens directly to a contract does not perform these actions.",
    ],
  },
  {
    question: "How does Earn work?",
    answer: [
      "Deposit USDG into an open lending pool to receive shares. Borrower interest increases share value after protocol fees, while liquidation shortfalls can reduce it. Each market has separate funds and loss exposure.",
      "Borrower APR is not lender APY. Your return depends on pool usage, interest received and losses. Withdrawals depend on available USDG and loan health, so position value may exceed what you can withdraw now.",
    ],
  },
  {
    question: "Why might a market be unavailable?",
    answer: [
      "New borrowing depends on current prices, trading-session checks and liquidation readiness. If these checks fail, actions that increase risk are restricted.",
      "The market screen explains which actions can still be reviewed. A recovered website or price feed alone does not mean borrowing is available again.",
    ],
  },
  FAQ_ITEMS[FAQ_ITEMS.length - 1]!,
] as const;

type PreviewMarket = (typeof MVP_MARKETS)[number];

const MARKET_NAMES: Record<string, string> = Object.fromEntries(
  MVP_MARKETS.map(({ name, symbol }) => [symbol, name]),
);

function TokenContract({ address, stock, symbol }: { address: string; stock: boolean; symbol: string }) {
  const [copied, setCopied] = useState(false);
  const [open, setOpen] = useState(false);
  const panelId = `token-contract-${symbol.toLowerCase()}`;
  const label = stock ? "Stock Token contract" : "Token contract";
  const explorerBase = "https://robinhoodchain.blockscout.com";

  const copyAddress = async () => {
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  return (
    <span
      className="rusd-contract-chip"
      data-open={open || undefined}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          setOpen(false);
          event.currentTarget.querySelector<HTMLElement>(".rusd-ticker")?.focus();
        }
      }}
    >
      <button
        aria-controls={panelId}
        aria-expanded={open}
        aria-label={`Show ${symbol} ${label}`}
        className="rusd-ticker"
        onClick={() => {
          setCopied(false);
          setOpen((value) => !value);
        }}
        type="button"
      >
        {symbol}
      </button>
      <span aria-label={`${symbol} ${label}`} className="rusd-contract-panel" id={panelId} role="group">
        <span className="rusd-contract-label">{label}</span>
        <code>{address}</code>
        <span className="rusd-contract-actions">
          <button onClick={copyAddress} type="button">{copied ? "Copied" : "Copy address"}</button>
          <a href={`${explorerBase}/address/${address}`} rel="noreferrer" target="_blank">View on explorer</a>
        </span>
      </span>
    </span>
  );
}

function MarketIdentity({ name, symbol }: { name: string; symbol: string }) {
  const stock = getDockyardMarket(symbol);
  const generic = getIsolatedAsset(symbol);
  const token = stock ?? generic;
  return (
    <div className="rusd-market-name">
      {token
        ? <TokenContract address={token.address} stock={Boolean(stock)} symbol={symbol} />
        : <span className="rusd-ticker">{symbol}</span>}
      <span className="rusd-market-meta">
        <span className="rusd-market-company">{name}</span>
        <span className="rusd-market-type">Isolated market</span>
      </span>
    </div>
  );
}

function MarketRow({ symbol, branchId }: { symbol: CollateralSymbol; branchId: BranchId }) {
  const collateral = getCollToken(branchId);
  const maxLtv = collateral?.collateralRatio
    ? `${(100 / collateral.collateralRatio).toFixed(1).replace(".0", "")}%`
    : "—";

  return (
    <tr>
      <td>
        <MarketIdentity name={MARKET_NAMES[symbol] ?? String(symbol)} symbol={symbol} />
      </td>
      <td className="rusd-ltv">{maxLtv}</td>
      <td>
        <Link className="rusd-action" href={`/borrow/${symbol.toLowerCase()}`}>Borrow</Link>
      </td>
    </tr>
  );
}

function PreviewMarketRow({
  market,
  live,
  selected,
  onSelect,
}: {
  market: PreviewMarket;
  live: boolean;
  selected: boolean;
  onSelect: (market: PreviewMarket) => void;
}) {
  return (
    <tr data-selected={selected || undefined}>
      <td>
        <MarketIdentity name={market.name} symbol={market.symbol} />
      </td>
      <td className="rusd-ltv">{market.maxLtv}</td>
      <td>
        {live
          ? <Link className="rusd-action" href={`/borrow?market=${market.symbol.toLowerCase()}`}>Borrow</Link>
          : (
            <button
              aria-pressed={selected}
              className="rusd-action rusd-preview-action"
              onClick={() => onSelect(market)}
              type="button"
            >
              {selected ? "Selected" : "View"}
            </button>
          )}
      </td>
    </tr>
  );
}

function RotatingMarketSymbol({ symbol }: { symbol: string }) {
  const previousSymbol = useRef(symbol);
  const outgoingSymbol = previousSymbol.current;
  const isChanging = outgoingSymbol !== symbol;

  useEffect(() => {
    previousSymbol.current = symbol;
  }, [symbol]);

  return (
    <strong aria-label={symbol} className="rusd-position-symbol-window">
      {isChanging && (
        <span
          aria-hidden="true"
          className="rusd-position-symbol"
          data-phase="outgoing"
          key={`out-${outgoingSymbol}-${symbol}`}
        >
          {outgoingSymbol}
        </span>
      )}
      <span
        aria-hidden="true"
        className="rusd-position-symbol"
        data-phase={isChanging ? "incoming" : "stable"}
        key={`in-${symbol}`}
      >
        {symbol}
      </span>
    </strong>
  );
}

function PositionMechanism({
  market,
  showLimits = true,
}: {
  market: PreviewMarket;
  showLimits?: boolean;
}) {
  return (
    <figure className="rusd-position-preview turret-loan-story">
      <img
        className="turret-loan-art"
        src="/illustrations/turret-collateral-bridge-v1.webp"
        alt=""
        width={1536}
        height={1024}
        fetchPriority="high"
      />

      <div
        aria-label={`Deposit a ${market.symbol} Stock Token as collateral and borrow USDG against it`}
        className="rusd-position-path"
        role="img"
      >
        <div className="rusd-position-node">
          <span>You deposit</span>
          <RotatingMarketSymbol symbol={market.symbol} />
          <small>Stock Token</small>
        </div>
        <span aria-hidden="true" className="rusd-position-route">
          <svg fill="none" viewBox="0 0 40 40">
            <circle cx="20" cy="20" r="19" />
            <path d="M12.5 20h14M21 14.5l5.5 5.5-5.5 5.5" />
          </svg>
        </span>
        <div className="rusd-position-node">
          <span>You borrow</span>
          <strong>USDG</strong>
          <small>Stablecoin</small>
        </div>
      </div>

      {showLimits && (
        <div className="rusd-position-risk">
          <div className="rusd-position-risk-heading">
            <span>Borrow limit</span>
            <strong>{market.maxLtv}</strong>
          </div>
          <span aria-hidden="true" className="rusd-position-risk-track">
            <span />
          </span>
          <div className="rusd-position-risk-scale">
            <span>Safer</span>
            <span>Borrowing limit</span>
          </div>
        </div>
      )}

      <figcaption>
        Repay USDG plus interest to unlock your tokens.
      </figcaption>

      <div className="rusd-position-safeguards">
        <span>{showLimits ? `Liquidation above ${market.liquidationLtv}` : "Market limits apply"}</span>
        <span>Availability varies</span>
      </div>
    </figure>
  );
}

function MarketAvailability({
  market,
  availability,
  now,
}: {
  market: IsolatedMarket;
  availability?: StockMarketAvailability;
  now: number;
}) {
  if (market.admission === "commissioning") {
    return <MarketStatus state="pending" label="Not open yet" />;
  }
  if (!availability || availability.state === "checking") {
    return <MarketStatus state="checking" label="Checking…" />;
  }
  if (availability.state === "open") {
    return <MarketStatus state="open" label="Open now" />;
  }
  if (availability.state === "closed" && availability.reopensAt * 1_000 > now) {
    const opening = new Intl.DateTimeFormat(undefined, {
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short",
    }).format(new Date(availability.reopensAt * 1_000));
    return (
      <MarketStatus
        state="closed"
        label="Closed"
        title={`Opens ${opening}`}
        detail={
          <>
            Opens in{" "}
            <time dateTime={new Date(availability.reopensAt * 1_000).toISOString()}>
              {marketCountdown(availability.reopensAt, now)}
            </time>
          </>
        }
      />
    );
  }
  return <MarketStatus state="unavailable" label="Unavailable" />;
}

type MarketStatusState = "pending" | "checking" | "open" | "closed" | "unavailable";

function MarketStatus({
  state,
  label,
  detail,
  title,
}: {
  state: MarketStatusState;
  label: string;
  detail?: ReactNode;
  title?: string;
}) {
  return (
    <span className="rusd-market-status" data-state={state} title={title}>
      <span aria-hidden="true" className="rusd-market-status-icon">
        <svg fill="none" viewBox="0 0 18 18">
          {state === "open"
            ? <path d="m5 9.2 2.45 2.45L13.2 6" />
            : state === "unavailable"
            ? (
              <>
                <circle cx="9" cy="9" r="5.25" />
                <path d="M5.3 12.7 12.7 5.3" />
              </>
            )
            : state === "checking"
            ? (
              <>
                <path d="M14.25 9A5.25 5.25 0 1 1 9 3.75" />
                <path d="M9 3.75h3.35v3.3" />
              </>
            )
            : (
              <>
                <circle cx="9" cy="9" r="5.25" />
                <path d="M9 6.1V9l2 1.2" />
              </>
            )}
        </svg>
      </span>
      <span className="rusd-market-status-copy">
        <strong>{label}</strong>
        {detail && <span className="rusd-market-status-detail">{detail}</span>}
      </span>
    </span>
  );
}

export function HomeScreen() {
  const standaloneMarkets = READ_ONLY_DEPLOYMENT || DOCKYARD_STANDALONE_DEPLOYMENT;
  const branches = standaloneMarkets ? [] : getBranches();
  const poolMode = !READ_ONLY_DEPLOYMENT && ISOLATED_MARKETS.length > 0;
  const rotationMarkets = poolMode ? CONFIGURED_PREVIEW_MARKETS : MVP_MARKETS;
  const [selectedMarket, setSelectedMarket] = useState<PreviewMarket>(rotationMarkets[0] ?? MVP_MARKETS[0]);
  const [marketRotationEnabled, setMarketRotationEnabled] = useState(true);
  const [marketAvailability, setMarketAvailability] = useState<Record<string, StockMarketAvailability>>({});
  const [clock, setClock] = useState(Date.now());
  useEffect(() => {
    if (!marketRotationEnabled || rotationMarkets.length < 2) return;

    const timer = window.setInterval(() => {
      setSelectedMarket((currentMarket) => {
        const currentIndex = rotationMarkets.findIndex(({ symbol }) => symbol === currentMarket.symbol);
        return rotationMarkets[(currentIndex + 1) % rotationMarkets.length]!;
      });
    }, MARKET_ROTATION_INTERVAL_MS);

    return () => window.clearInterval(timer);
  }, [marketRotationEnabled, rotationMarkets]);

  useEffect(() => {
    if (!poolMode) return;
    let active = true;
    const refresh = async () => {
      const markets = ISOLATED_MARKETS.filter((market) => market.admission !== "commissioning");
      const readings = await Promise.all(markets.map((market) => fetchStockMarketAvailability(market)));
      if (!active) return;
      setMarketAvailability(Object.fromEntries(markets.map((market, index) => [market.engine, readings[index]!])));
    };
    void refresh();
    const statusTimer = window.setInterval(() => void refresh(), MARKET_STATUS_REFRESH_INTERVAL_MS);
    const clockTimer = window.setInterval(() => setClock(Date.now()), 1_000);
    return () => {
      active = false;
      window.clearInterval(statusTimer);
      window.clearInterval(clockTimer);
    };
  }, [poolMode]);

  const handleMarketSelect = (market: PreviewMarket) => {
    setMarketRotationEnabled(false);
    setSelectedMarket(market);
  };

  return (
    <div className="rusd-home">
      <section className="rusd-hero">
        <div className="rusd-hero-message">
          <h1>Borrow against memecoins, stocks and NFTs</h1>
          <p className="rusd-hero-copy">
            Borrow USDG against supported assets without selling them. Choose a pool loan or agree terms directly with a lender on Robinhood Chain.
          </p>
          <div className="rusd-hero-proof">
            <span>
              {poolMode
                ? `${ISOLATED_MARKETS.length} configured ${ISOLATED_MARKETS.length === 1 ? "market" : "markets"}`
                : "10 Stock Tokens"}
            </span>
            <span>Robinhood Chain</span>
          </div>
        </div>
        <PositionMechanism market={selectedMarket} showLimits={!poolMode} />
      </section>

      <section className="rusd-explainer" id="how-it-works">
        <div className="rusd-explainer-heading">
          <h2>How it works</h2>
          <p>{poolMode ? "Collateral token in. USDG out." : "Stock Token in. USDG out."}</p>
        </div>
        <ol aria-label="How borrowing works" className="rusd-borrow-flow">
          <li>
            <strong>Deposit a {poolMode ? "collateral token" : "Stock Token"}</strong>
            <p>Your tokens move from your wallet into the lending contract as security for your loan.</p>
          </li>
          <li>
            <strong>Borrow USDG</strong>
            <p>The lender’s USDG goes to your wallet. You owe that amount plus interest; your collateral stays in the contract.</p>
          </li>
          <li>
            <strong>Repay and withdraw</strong>
            <p>Pay the debt plus interest to recover your remaining collateral. An unsafe loan can be liquidated before you repay.</p>
          </li>
        </ol>
      </section>

      <section className="rusd-market-panel">
        <div className="rusd-market-heading">
          <div>
            <h2 className="rusd-market-title">Choose your {poolMode ? "collateral" : "Stock Token"}</h2>
            <p>
              {poolMode
                ? "Open a market to see its current availability and loan terms. Hover or tap a ticker for its token contract."
                : "See each borrowing limit. Hover or tap a ticker for its token contract."}
            </p>
          </div>
          {READ_ONLY_DEPLOYMENT && <span className="rusd-market-selected">Selected {selectedMarket.symbol}</span>}
        </div>
        <table className="rusd-market-table">
          <caption className="sr-only">
            Choose your collateral from{" "}
            {poolMode ? ISOLATED_MARKETS.length : standaloneMarkets ? MVP_MARKETS.length : branches.length}{" "}
            isolated collateral markets
          </caption>
          <thead>
            <tr>
              <th scope="col">Market</th>
              <th scope="col">{poolMode ? "Status" : "Borrow limit"}</th>
              <th scope="col">
                <span className="sr-only">Action</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {poolMode
              ? ISOLATED_MARKETS.map((m) => (
                <tr key={m.engine}>
                  <td>
                    <MarketIdentity name={getIsolatedAsset(m.symbol)?.name ?? MARKET_NAMES[m.symbol] ?? m.symbol} symbol={m.symbol} />
                  </td>
                  <td>
                    <MarketAvailability market={m} availability={marketAvailability[m.engine]} now={clock} />
                  </td>
                  <td>
                    <Link className="rusd-action" href={`/borrow?engine=${m.engine}`}>View market</Link>
                  </td>
                </tr>
              ))
              : standaloneMarkets
              ? MVP_MARKETS.map((market) => (
                <PreviewMarketRow
                  key={market.symbol}
                  live={DOCKYARD_STANDALONE_DEPLOYMENT}
                  market={market}
                  onSelect={handleMarketSelect}
                  selected={selectedMarket.symbol === market.symbol}
                />
              ))
              : branches.map(({ id, symbol }) => <MarketRow branchId={id} key={symbol} symbol={symbol} />)}
          </tbody>
        </table>
      </section>

      <DeferredMarkets />
      <aside className="rusd-info">
        <span aria-hidden="true" className="rusd-info-icon">i</span>
        <div>
          <strong>Your collateral token backs the loan.</strong>
          <p>
            If its price falls too much, it can be sold to repay the USDG. Borrowing may pause when the market is closed
            or price data is unavailable.
          </p>
        </div>
        <HowBorrowingWorks />
      </aside>

      <section aria-labelledby="dockyard-faq-title" className="rusd-faq" id="faq">
        <div className="rusd-faq-heading">
          <h2 id="dockyard-faq-title">Questions before you borrow?</h2>
          <p>From your first deposit to repayment, fees, and liquidation.</p>
        </div>
        <div className="rusd-faq-list">
          {(poolMode ? POOL_FAQ_ITEMS : FAQ_ITEMS).map(({ answer, question }, index) => (
            <details key={question} open={index === 0}>
              <summary>
                <span>{question}</span>
                <span aria-hidden="true" className="rusd-faq-toggle" />
              </summary>
              <div className="rusd-faq-answer">
                {answer.map((paragraph) => <p key={paragraph}>{paragraph}</p>)}
              </div>
            </details>
          ))}
        </div>
      </section>
    </div>
  );
}
