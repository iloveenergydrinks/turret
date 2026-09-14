import { TermLabel } from "../../comps/FieldInfo/FieldInfo";
import { termPercent } from "../../comps/LoanInterestField/interest";
import type { Address } from "viem";
import type { Deployment, Loan } from "../../p2p/client";

export const GRACE = 86_400;
export const ZERO_ADDRESS: Address = "0x0000000000000000000000000000000000000000";
export type Offer = { market: Deployment; loan: Loan };
export const sameAddress = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
export const validAddress = (value: string): value is Address =>
  /^0x[0-9a-fA-F]{40}$/.test(value) && !sameAddress(value, ZERO_ADDRESS);
export const shortAddress = (value: string) => `${value.slice(0, 6)}…${value.slice(-4)}`;
export const offerKey = ({ market, loan }: Offer) => `${market.address.toLowerCase()}:${loan.id}`;
export const isLegacy = (market: Deployment) => market.legacy || (market.version !== 2 && market.version !== 3);
export function parseAmount(value: string, decimals: number) {
  if (!/^\d+(\.\d+)?$/.test(value.trim())) throw new Error("Enter amounts using digits and a decimal point.");
  const [whole = "0", fraction = ""] = value.trim().split(".");
  if (fraction.length > decimals) throw new Error(`This token supports no more than ${decimals} decimal places.`);
  if (whole.length > 78) throw new Error("This amount is too large.");
  const result = BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, "0"));
  if (result >= 2n ** 256n) throw new Error("This amount is too large.");
  return result;
}
export function formatAmount(value: bigint, decimals: number) {
  const scale = 10n ** BigInt(decimals);
  const fraction = (value % scale).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${value / scale}${fraction ? `.${fraction}` : ""}`;
}
export const loanAmount = (value: bigint, market: Deployment) =>
  `${formatAmount(value, market.loanDecimals)} ${market.loanSymbol}`;
export const collateralAmount = (value: bigint, market: Deployment) =>
  `${formatAmount(value, market.collateralDecimals)} ${market.collateralSymbol}`;
export const displayDate = (seconds: number) =>
  !Number.isFinite(seconds) || Number.isNaN(new Date(seconds * 1000).getTime())
    ? "Date unavailable"
    : new Intl.DateTimeFormat("en-GB", {
      day: "numeric",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      timeZone: "UTC",
    }).format(seconds * 1000) + " UTC";
export const localDateInput = (seconds: number) => {
  const date = new Date(seconds * 1000);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
};
export const finalDeadline = (loan: Pick<Loan, "dueAt" | "repaymentDeadline">) => loan.repaymentDeadline ?? loan.dueAt + GRACE;
export function loanState(loan: Loan, now: number) {
  if (loan.status === "open") {
    if (now >= loan.expiresAt) return "Expired · refund available";
    if (loan.vault && loan.fundingAvailable === undefined) return "Funding balance unavailable";
    if (loan.fundingAvailable !== undefined && loan.fundingAvailable < loan.principal) return "Funding shortfall · cannot accept";
    return "Funded · open";
  }
  if (loan.status === "active") {
    if (now > finalDeadline(loan)) return "Default · collateral claimable";
    return now > loan.dueAt ? finalDeadline(loan) > loan.dueAt + GRACE ? "Extended · repayment due" : "Grace period · repayment due" : "Active loan";
  }
  return ({ repaid: "Repaid", claimed: "Settled in collateral", cancelled: "Cancelled", expired: "Expired" })[
    loan.status
  ];
}
const compare = <T extends bigint | number | string,>(left: T, right: T) => left < right ? -1 : left > right ? 1 : 0;
const hasRate = (loan: Pick<Loan, "principal" | "interest">) => loan.principal > 0n && loan.interest >= 0n;

/** Total fixed interest, not an annualized rate. Truncation never rounds a positive rate down to zero. */
export function fixedInterestPercent(loan: Pick<Loan, "principal" | "interest">): string {
  if (!hasRate(loan)) return "—";
  const hundredths = loan.interest * 10_000n / loan.principal;
  if (loan.interest > 0n && hundredths === 0n) return "<0.01%";
  return `${formatAmount(hundredths, 2)}%`;
}

export function sortOffers(offers: readonly Offer[], sort: string) {
  return [...offers].sort((a, b) => {
    let result: number;
    switch (sort) {
      case "amount": result = compare(a.loan.principal, b.loan.principal); break;
      case "amount-desc": result = compare(b.loan.principal, a.loan.principal); break;
      case "duration": result = compare(a.loan.durationDays, b.loan.durationDays); break;
      case "duration-desc": result = compare(b.loan.durationDays, a.loan.durationDays); break;
      case "interest": result = compare(a.loan.interest, b.loan.interest); break;
      case "rate":
      case "rate-desc": {
        const validA = hasRate(a.loan), validB = hasRate(b.loan);
        // Invalid terms sort last in either direction; valid rates retain all integer precision.
        result = validA !== validB ? (validA ? -1 : 1)
          : !validA ? 0 : compare(a.loan.interest * b.loan.principal, b.loan.interest * a.loan.principal)
            * (sort === "rate-desc" ? -1 : 1);
        break;
      }
      case "expiry": result = compare(a.loan.expiresAt, b.loan.expiresAt); break;
      default: {
        const createdAt = (loan: Loan) => Number.isSafeInteger(loan.createdAt) && loan.createdAt > 0 ? loan.createdAt : 0;
        // V2 exposes actual creation timestamps. V1 has no timestamp; unknown dates follow known dates.
        result = compare(createdAt(b.loan), createdAt(a.loan));
      }
    }
    // IDs order creation within one escrow only. Cross-market timestamp ties use identity, not a global ID chronology.
    return result || compare(a.market.address.toLowerCase(), b.market.address.toLowerCase())
      || compare(a.market.chainId, b.market.chainId) || compare(b.loan.id, a.loan.id);
  });
}

/** Explain the connected wallet's role without confusing a listing with an accepted loan. */
export function LoanOwnership({ offer, account, now }: { offer: Offer; account?: string | null; now: number }) {
  const { loan, market } = offer;
  const lender = !!account && sameAddress(account, loan.lender);
  const borrower = !!account && validAddress(loan.borrower) && sameAddress(account, loan.borrower);
  const open = loan.status === "open";
  const expired = open && now >= loan.expiresAt;
  const active = loan.status === "active";
  const overdue = active && now > finalDeadline(loan);
  const principal = loanAmount(loan.principal, market);
  const repayment = loanAmount(loan.principal + loan.interest, market);
  const collateral = collateralAmount(loan.collateral, market);
  const custody = market.version === 3 ? "this loan’s vault" : "the lending contract";
  const title = lender ? "You are the lender — you supply the USDG"
    : borrower ? open ? "You are the invited borrower" : "You are the borrower — you owe the repayment"
    : !account ? "Who lends, who borrows?"
    : open && loan.isPublic && !expired ? "You can borrow from this lender"
    : "You are viewing another wallet’s loan";
  let location: string;
  if (open) {
    location = market.version === 3
      ? loan.fundingAvailable === undefined ? "The vault’s current USDG balance could not be verified. Refresh before taking action."
        : `${loanAmount(loan.fundingAvailable, market)} is held in ${custody}. No borrower has received this loan yet.`
      : `The lender deposited ${principal} into ${custody}. No borrower has received this loan yet.`;
    if (market.version === 3 && loan.fundingAvailable !== undefined && loan.fundingAvailable < loan.principal) {
      location += " This is less than the promised loan amount; the offer cannot be accepted.";
    }
  } else if (active) {
    location = `The borrower received ${principal}. The borrower’s collateral is held in ${custody}, not in the lender’s wallet.`;
  } else if (loan.status === "repaid") {
    location = "The borrower repaid. The lender is entitled to the repayment; the borrower is entitled to the remaining collateral. Check withdrawal balances for anything still to collect.";
  } else if (loan.status === "claimed") {
    location = "Default was settled. The lender is entitled to the remaining collateral instead of repayment. The borrower no longer owes USDG. Check withdrawal balances for anything still to collect.";
  } else {
    location = "This offer ended without a loan. The lender is entitled to the remaining funding. Check withdrawal balances for anything still to collect.";
  }
  return (
    <section className="p2p-ownership" aria-label="Your role and the money flow">
      <h3>{title}</h3>
      {lender && open && <p>You put up {principal}. You do not receive {principal} by creating this offer.</p>}
      <Exchange principal={principal} collateral={collateral} symbol={market.collateralSymbol}
        lender={lender} started={loan.dueAt > 0} ended={!open && !active && loan.dueAt === 0} />
      <dl>
        <div><dt>Lender · supplies USDG</dt><dd><span title={loan.lender}>{shortAddress(loan.lender)}</span>{lender && " · you"}</dd></div>
        <div><dt>Borrower · supplies collateral</dt><dd>{validAddress(loan.borrower)
          ? <><span title={loan.borrower}>{shortAddress(loan.borrower)}</span>{borrower && " · you"}{open && " · has not accepted"}</>
          : open ? "No borrower yet · anyone with the collateral can accept" : "No borrower · offer never accepted"}</dd></div>
        <div><dt>Where the assets are now</dt><dd>{location}</dd></div>
        {(open && !expired || active) && <>
          {open && <div><dt>When someone accepts</dt><dd>The borrower deposits {collateral} into {custody} and receives the lender’s {principal}. The {loan.durationDays}-day loan starts then.</dd></div>}
          <div><dt>{overdue ? "The final deadline has passed" : "If the borrower repays on time"}</dt><dd>{overdue
            ? "Repayment is no longer available. Settle the default to assign the remaining collateral to the lender."
            : `The borrower pays ${repayment}. The lender can withdraw that repayment; the borrower can withdraw the remaining collateral. Withdrawals are separate transactions.`}</dd></div>
          {!overdue && <div><dt>If the final deadline is missed</dt><dd>The lender can settle the default and withdraw the remaining collateral instead of {repayment}. Its value may be lower than the loan. The borrower loses that collateral.</dd></div>}
        </>}
        {open && <div><dt>{expired ? "Offer expired" : "Until someone accepts"}</dt><dd>{expired
          ? "No loan started. Release the expired funding, then the lender can withdraw what remains."
          : "No interest is earned. The lender can cancel, then withdraw the released USDG in a separate transaction."}</dd></div>}
      </dl>
    </section>
  );
}

export function Exchange({ principal, collateral, symbol, lender = false, started = false, ended = false }: { principal: string; collateral: string; symbol: string; lender?: boolean; started?: boolean; ended?: boolean }) {
  return (
    <div className="p2p-exchange" aria-label="Loan exchange">
      <div>
        <span className="p2p-token-mark" aria-hidden="true">USDG</span>
        <span>{ended ? "Original loan amount · offer ended" : lender ? started ? "You lent to the borrower" : "You supply · borrower receives" : started ? "Borrower received" : "Borrower receives on acceptance"}</span>
        <strong>{principal}</strong>
      </div>
      <svg className="p2p-exchange-arrow" width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path
          d="M4 9h15m-4-4 4 4-4 4M20 16H5m4-4-4 4 4 4"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      <div>
        <span className="p2p-token-mark" aria-hidden="true">{symbol}</span>
        <span>{ended ? "Collateral was not deposited" : started ? "Borrower deposited as collateral" : "Borrower must deposit as collateral"}</span>
        <strong>{collateral}</strong>
      </div>
    </div>
  );
}
export function LoanTerms({ offer, now, account, detailed = false }: { offer: Offer; now: number; account?: string | null; detailed?: boolean }) {
  const { loan, market } = offer;
  const started = loan.dueAt > 0;
  return (
    <>
      {detailed && <LoanOwnership offer={offer} account={account} now={now} />}
      {!detailed && <Exchange
        ended={!["open", "active"].includes(loan.status) && !started}
        lender={!!account && sameAddress(account, loan.lender)}
        started={started}
        principal={loanAmount(loan.principal, market)}
        collateral={collateralAmount(loan.collateral, market)}
        symbol={market.collateralSymbol}
      />}
      <p className="p2p-help">Collateral is measured in token units.</p>
      <dl className="p2p-cost">
        <div>
          <dt><TermLabel topic="interest" helpLabel="Interest for this loan">Interest for this loan</TermLabel></dt>
          <dd>{loanAmount(loan.interest, market)} · {termPercent(loan.principal, loan.interest)} for the full term</dd>
        </div>
        <div className="p2p-total">
          <dt><TermLabel topic="repayment" helpLabel="Total repayment">Total repayment</TermLabel></dt>
          <dd>{loanAmount(loan.principal + loan.interest, market)}</dd>
        </div>
      </dl>
      <ol className="p2p-timeline" aria-label="Repayment timeline">
        <li data-current={!started}>
          <span>Acceptance</span>
          <strong>{started ? market.version === 3 ? "Loan accepted" : displayDate(loan.dueAt - loan.durationDays * GRACE) : "Loan clock starts"}</strong>
        </li>
        <li data-current={started && now <= loan.dueAt}>
          <span>Due date</span>
          <strong>{started ? displayDate(loan.dueAt) : `${loan.durationDays} days later`}</strong>
        </li>
        <li data-current={started && now > loan.dueAt}>
          <span>Final deadline</span>
          <strong>{started ? displayDate(finalDeadline(loan)) : "+ 24-hour grace period"}</strong>
        </li>
      </ol>
      {market.version === 3 && <V3CustodyNotice />}
      {loan.status === "open" && (
        <>
          <p className="p2p-help">Offer expires {displayDate(loan.expiresAt)}. The loan starts only when accepted.</p>
          <p className="p2p-help">The final repayment deadline keeps running during token restrictions or network outages. A pause on new loans does not extend it.</p>
        </>
      )}
    </>
  );
}

export function V3CustodyNotice() {
  return <p className="p2p-help p2p-custody-notice">Each offer has its own token vault. If the token issuer removes tokens or their balance falls, only this loan bears that loss. Settlement returns the collateral still available; other loans do not cover a shortfall. V3 has been tested and reviewed internally, with no external audit.</p>;
}
