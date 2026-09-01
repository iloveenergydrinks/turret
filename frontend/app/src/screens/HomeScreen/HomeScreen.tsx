"use client";

import type { BranchId, CollateralSymbol } from "@/src/types";

import { READ_ONLY_DEPLOYMENT } from "@/src/deployment-config";
import { getBranches, getCollToken } from "@/src/liquity-utils";
import Link from "next/link";
import { useState } from "react";

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

const FAQ_ITEMS = [
  {
    question: "What does Dockyard do?",
    answer: [
      "Dockyard is a collateralized lending vault on Robinhood Chain. You lock one supported Stock Token in an isolated market and borrow USDG already held by the vault.",
      "The token is not sold when the loan opens, so its value can still rise or fall while it is locked. If the position is liquidated, some or all of that token can be taken to repay the debt.",
    ],
  },
  {
    question: "Does Dockyard create USDG?",
    answer: [
      "No. USDG is an existing token; Dockyard does not mint it. The vault must already contain enough USDG to fund a loan, so a safe borrow can still fail when available liquidity is too low.",
    ],
  },
  {
    question: "How do I open and close a loan?",
    answer: [
      "Choose one Stock Token market, approve the token, deposit it, and enter the amount of USDG you want to borrow. The transaction succeeds only if the resulting debt is below that market’s borrowing limit, its debt ceiling has room, the vault has USDG, and the price checks pass.",
      "To close, repay the full USDG debt and withdraw the Stock Token. You can also repay or withdraw part of the position, provided the remaining loan stays below its borrowing limit.",
    ],
  },
  {
    question: "What is LTV?",
    answer: [
      "Loan-to-value is your USDG debt divided by the current dollar value of your deposited Stock Token. A position with $400 of debt and $1,000 of collateral has a 40% LTV.",
      "Your LTV rises if the Stock Token price falls or you borrow more. It falls if the token price rises, you add collateral, or you repay debt.",
    ],
  },
  {
    question: "What is the difference between the borrowing limit and liquidation level?",
    answer: [
      "The borrowing limit is the highest LTV at which the standalone MVP vault lets you create or increase a loan. It sits five percentage points below the market’s liquidation level to leave a buffer.",
      "For AAPL, the borrowing limit is 52.1% and liquidation starts above 57.1%. The limits are lower for more volatile Stock Tokens, and borrowing right at the limit leaves little room for a price drop.",
    ],
  },
  {
    question: "What does borrowing cost?",
    answer: [
      "The standalone MVP deployment tooling defaults to a one-time 0.5% origination fee. You receive the USDG amount you requested, and the fee is added to your debt. That fee also counts toward your LTV.",
      "The current standalone vault does not accrue ongoing interest. Confirm the fee, total debt, and network transaction details in the interface before signing because deployment parameters can change.",
    ],
  },
  {
    question: "How do liquidations work?",
    answer: [
      "When a position moves above its market’s liquidation level, any liquidator can repay USDG against its debt. In return, the contract sends the liquidator Stock Token collateral worth the repaid amount plus a 5% liquidation bonus.",
      "A liquidation can be partial or complete. Any collateral and debt left after a partial liquidation stay in the position. If all collateral is exhausted and debt remains, the vault owner can write off that bad debt.",
    ],
  },
  {
    question: "How does Dockyard decide the Stock Token price?",
    answer: [
      "The standalone vault checks that the Stock Token itself is not oracle-paused, then reads two price feeds. When both are valid and close enough, it uses the lower price. If one feed is invalid, it can use the other. If both fail or disagree too much, price-dependent actions stop.",
      "The current deployment tooling uses a 24-hour maximum price age and a 2% maximum difference between valid feeds. Those checks reduce oracle risk; they do not remove it.",
    ],
  },
  {
    question: "What happens when the stock market is closed or a token is paused?",
    answer: [
      "Deposits and new borrowing stop if the Stock Token reports that its oracle is paused. Withdrawals that need a fresh safety check and liquidations can also stop when no valid price is available.",
      "Repayment does not depend on a price feed. After the debt reaches zero, the borrower can withdraw the remaining collateral.",
    ],
  },
  {
    question: "How does Earn work?",
    answer: [
      "Public Earn deposits are not enabled in this MVP. USDG liquidity is supplied by the vault owner, and the current contract does not issue pool shares or give public funders a withdrawal claim.",
      "Do not send USDG to the funding function expecting yield. A public Earn product would require separate pool accounting, withdrawal rights, and risk disclosures before it could be enabled.",
    ],
  },
  {
    question: "Are the Stock Token markets connected?",
    answer: [
      "Each Stock Token has its own borrowing limit, liquidation level, debt ceiling, and price feeds. AAPL collateral does not back an NVDA loan. All markets do, however, draw from the same available USDG balance in the vault.",
    ],
  },
  {
    question: "Does Dockyard use redemptions or Stability Pools?",
    answer: [
      "No. The standalone USDG vault does not use Liquity redemptions, Stability Pools, borrower-set interest rates, governance staking, or a protocol-issued stablecoin. Its core loop is simpler: supplied USDG goes out as loans, and repayments return USDG to the vault.",
    ],
  },
  {
    question: "What control does the vault owner have?",
    answer: [
      "The owner can pause the vault, enable or disable individual markets, change market debt ceilings, withdraw USDG that has not been borrowed, and write off debt only after a position has no collateral left.",
      "Those controls are part of the MVP’s trust model. They should move to stronger operational controls before the system handles meaningful value.",
    ],
  },
  {
    question: "What are the main risks?",
    answer: [
      "The main risks are Stock Token price moves, liquidation, oracle failure, smart-contract bugs, limited USDG liquidity, token pauses or corporate actions, and owner-key risk. Depositing a Stock Token is not the same as holding a share in a brokerage account.",
      "The MVP has not completed an independent audit. Only use it if you understand that the contracts and parameters can fail and that losses may be permanent.",
    ],
  },
] as const;

type PreviewMarket = (typeof MVP_MARKETS)[number];

const MARKET_NAMES: Record<string, string> = Object.fromEntries(
  MVP_MARKETS.map(({ name, symbol }) => [symbol, name]),
);

function MarketIdentity({ name, symbol }: { name: string; symbol: string }) {
  return (
    <div className="rusd-market-name">
      <span className="rusd-ticker">{symbol}</span>
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
  selected,
  onSelect,
}: {
  market: PreviewMarket;
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
        <button
          aria-pressed={selected}
          className="rusd-action rusd-preview-action"
          onClick={() => onSelect(market)}
          type="button"
        >
          {selected ? "Selected" : "View"}
        </button>
      </td>
    </tr>
  );
}

function PositionMechanism({ market }: { market: PreviewMarket }) {
  return (
    <figure className="rusd-position-preview">
      <div className="rusd-position-head">
        <strong>{market.symbol} backs your USDG loan.</strong>
      </div>

      <div
        aria-label={`Deposit a ${market.symbol} Stock Token as collateral and borrow USDG against it`}
        className="rusd-position-path"
        role="img"
      >
        <div className="rusd-position-node">
          <span>Deposit</span>
          <strong>{market.symbol}</strong>
          <small>Stock Token</small>
        </div>
        <span aria-hidden="true" className="rusd-position-route">
          <svg fill="none" viewBox="0 0 40 40">
            <circle cx="20" cy="20" r="19" />
            <path d="M12.5 20h14M21 14.5l5.5 5.5-5.5 5.5" />
          </svg>
        </span>
        <div className="rusd-position-node">
          <span>Borrow</span>
          <strong>USDG</strong>
          <small>From Dockyard</small>
        </div>
      </div>

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

      <figcaption>
        Repay the USDG to get your {market.symbol} Stock Token back.
      </figcaption>

      <div className="rusd-position-safeguards">
        <span>Liquidation above {market.liquidationLtv}</span>
        <span>Two price checks</span>
      </div>
    </figure>
  );
}

export function HomeScreen() {
  const branches = READ_ONLY_DEPLOYMENT ? [] : getBranches();
  const [selectedMarket, setSelectedMarket] = useState<PreviewMarket>(MVP_MARKETS[0]);

  return (
    <div className="rusd-home">
      <section className="rusd-hero">
        <div className="rusd-hero-message">
          <h1>Borrow USDG against Stock Tokens.</h1>
          <p className="rusd-hero-copy">
            Deposit AAPL, NVDA, TSLA, or another supported Stock Token as collateral. Borrow USDG without selling it, so
            its value can still rise or fall while your loan is open.
          </p>
          <div className="rusd-hero-proof">
            <span>10 Stock Tokens</span>
            <span>Robinhood Chain</span>
          </div>
        </div>
        <PositionMechanism market={selectedMarket} />
      </section>

      <section className="rusd-explainer" id="how-it-works">
        <div className="rusd-explainer-heading">
          <h2>How it works</h2>
          <p>Stock Token in. USDG out.</p>
        </div>
        <ol aria-label="How borrowing works" className="rusd-borrow-flow">
          <li>
            <strong>Deposit a Stock Token</strong>
            <p>Use one supported token as collateral.</p>
          </li>
          <li>
            <strong>Borrow USDG</strong>
            <p>USDG goes to your wallet. Your token stays locked.</p>
          </li>
          <li>
            <strong>Repay and withdraw</strong>
            <p>Return the USDG and get your Stock Token back.</p>
          </li>
        </ol>
      </section>

      <section className="rusd-market-panel">
        <div className="rusd-market-heading">
          <div>
            <h2 className="rusd-market-title">Choose your Stock Token</h2>
            <p>See the borrowing limit for each token.</p>
          </div>
          {READ_ONLY_DEPLOYMENT && <span className="rusd-market-selected">Selected {selectedMarket.symbol}</span>}
        </div>
        <table className="rusd-market-table">
          <caption className="sr-only">
            Choose your collateral from {READ_ONLY_DEPLOYMENT ? MVP_MARKETS.length : branches.length}{" "}
            isolated Stock Token markets
          </caption>
          <thead>
            <tr>
              <th scope="col">Market</th>
              <th scope="col">Borrow limit</th>
              <th scope="col">
                <span className="sr-only">Action</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {READ_ONLY_DEPLOYMENT
              ? MVP_MARKETS.map((market) => (
                <PreviewMarketRow
                  key={market.symbol}
                  market={market}
                  onSelect={setSelectedMarket}
                  selected={selectedMarket.symbol === market.symbol}
                />
              ))
              : branches.map(({ id, symbol }) => <MarketRow branchId={id} key={symbol} symbol={symbol} />)}
          </tbody>
        </table>
      </section>

      <aside className="rusd-info">
        <span aria-hidden="true" className="rusd-info-icon">i</span>
        <div>
          <strong>Your Stock Token backs the loan.</strong>
          <p>
            If its price falls too much, it can be sold to repay the USDG. Borrowing may pause when the market is closed
            or price data is unavailable.
          </p>
        </div>
        {READ_ONLY_DEPLOYMENT
          ? <span className="rusd-preview-status">Preview · contracts pending</span>
          : <Link className="rusd-text-link" href="/borrow">How borrowing works</Link>}
      </aside>

      <section aria-labelledby="dockyard-faq-title" className="rusd-faq" id="faq">
        <div className="rusd-faq-heading">
          <h2 id="dockyard-faq-title">How Dockyard works, in detail.</h2>
          <p>The mechanics, limits, and risks behind borrowing USDG against Stock Tokens.</p>
        </div>
        <div className="rusd-faq-list">
          {FAQ_ITEMS.map(({ answer, question }, index) => (
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
