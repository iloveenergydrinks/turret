"use client";

import type { BranchId, CollateralSymbol } from "@/src/types";

import { READ_ONLY_DEPLOYMENT } from "@/src/deployment-config";
import { DOCKYARD_STANDALONE_DEPLOYMENT } from "@/src/dockyard-config";
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
    question: "What can I do with Dockyard?",
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
      "Dockyard lends existing USDG supplied to the vault by its owner. It does not create a new stablecoin or mint USDG when you borrow.",
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
      "This full-repayment exit does not need a price feed and remains available when Dockyard pauses borrowing or disables a market. It still requires enough USDG and ETH in your wallet, and the underlying tokens must allow transfers.",
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
    question: "How does Dockyard decide the Stock Token price?",
    answer: [
      "Dockyard reads two price feeds for each Stock Token. If both are valid and within 2% of each other, it uses the lower price. If only one is valid, it can use that feed. Prices 24 hours old or older are rejected.",
      "If neither feed is valid, they disagree too much, or the Stock Token reports an oracle pause, actions that need a price check stop. These checks reduce the chance of lending against a bad price, but cannot eliminate oracle risk.",
    ],
  },
  {
    question: "What happens when the stock market is closed or a token is paused?",
    answer: [
      "Market hours alone do not determine whether you can borrow. Dockyard relies on valid price data and the Stock Token’s oracle status. When those checks fail, new deposits, borrowing, liquidations, and collateral withdrawals that need a safety check are blocked.",
      "You can still repay your debt. Full repayment lets you reclaim your remaining collateral without a price check, provided the token itself allows the transfer. Price gaps when markets reopen can increase liquidation risk.",
    ],
  },
  {
    question: "Can I deposit USDG to earn yield?",
    answer: [
      "No. Dockyard does not offer public USDG deposits or an Earn account. Lending liquidity is supplied by the vault owner; there are no depositor shares or public yield claims.",
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
      "These controls can change borrowing availability. They do not allow the owner to withdraw a borrower’s Stock Token collateral directly or turn off full repayment through Dockyard’s pause controls. You still rely on the owner wallet being managed securely.",
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
  const standaloneMarkets = READ_ONLY_DEPLOYMENT || DOCKYARD_STANDALONE_DEPLOYMENT;
  const branches = standaloneMarkets ? [] : getBranches();
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
            Choose your collateral from {standaloneMarkets ? MVP_MARKETS.length : branches.length}{" "}
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
            {standaloneMarkets
              ? MVP_MARKETS.map((market) => (
                <PreviewMarketRow
                  key={market.symbol}
                  live={DOCKYARD_STANDALONE_DEPLOYMENT}
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
          <h2 id="dockyard-faq-title">Questions before you borrow?</h2>
          <p>From your first deposit to repayment, fees, and liquidation.</p>
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
