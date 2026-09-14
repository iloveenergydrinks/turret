import { FieldLabel, type LoanHelpTopic } from "../../comps/FieldInfo/FieldInfo";
import { LoanInterestField, useLoanInterest } from "../../comps/LoanInterestField/LoanInterestField";
import { termPercent } from "../../comps/LoanInterestField/interest";
import { useId, useState } from "react";
import type { Deployment } from "../../p2p/client";
import type { RequestTerms } from "../../p2p/requests";
import {
  collateralAmount,
  displayDate,
  formatAmount,
  loanAmount,
  localDateInput,
  parseAmount,
} from "./loanPresentation";

export function NegotiationTerms(
  { original, proposed, market }: { original: RequestTerms; proposed: RequestTerms; market: Deployment },
) {
  const rows: [string, (t: RequestTerms) => string][] = [
    ["USDG received", (t) => loanAmount(BigInt(t.principal), market)],
    ["Total repayment", (t) => loanAmount(BigInt(t.principal) + BigInt(t.interest), market)],
    ["Collateral at risk", (t) => collateralAmount(BigInt(t.collateral), market)],
    ["Total interest", (t) => `${loanAmount(BigInt(t.interest), market)} · ${termPercent(BigInt(t.principal), BigInt(t.interest))} for the full term`],
    ["Repay within", (t) => `${t.durationDays} days + 24h grace`],
    ["Accept offer before", (t) => displayDate(t.expiresAt)],
  ];
  return (
    <table className="p2p-neg-terms">
      <caption>Compare loan terms</caption>
      <thead>
        <tr>
          <th scope="col">Term</th>
          <th scope="col">Original offer</th>
          <th scope="col">Proposed</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(([label, value]) => {
          const before = value(original), after = value(proposed);
          return (
            <tr key={label}>
              <th scope="row">{label}</th>
              <td>{before}</td>
              <td>
                {before !== after
                  ? (
                    <>
                      <strong>{after}</strong>
                      <small>Changed</small>
                    </>
                  )
                  : after}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
export function NegotiationEditor(
  { market, original, initial, sourceExpiry, disabled, onSubmit }: {
    market: Deployment;
    original: RequestTerms;
    initial: RequestTerms;
    sourceExpiry: number;
    disabled: boolean;
    onSubmit: (terms: RequestTerms, responseBy: number) => Promise<void>;
  },
) {
  const id = useId();
  const [principal, setPrincipal] = useState(formatAmount(BigInt(initial.principal), market.loanDecimals));
  const [collateral, setCollateral] = useState(formatAmount(BigInt(initial.collateral), market.collateralDecimals));
  const interestModel = useLoanInterest(principal, market.loanDecimals, formatAmount(BigInt(initial.interest), market.loanDecimals));
  const { interest } = interestModel;
  const [days, setDays] = useState(String(initial.durationDays));
  const [expiry, setExpiry] = useState(localDateInput(initial.expiresAt));
  const [deadline, setDeadline] = useState(
    localDateInput(Math.min(Math.floor(Date.now() / 1000) + 86400, sourceExpiry - 60, initial.expiresAt - 60)),
  );
  const [review, setReview] = useState<{ terms: RequestTerms; responseBy: number } | null>(null);
  const [error, setError] = useState("");
  return (
    <form
      className="p2p-neg-editor"
      onSubmit={(event) => {
        event.preventDefault();
        setError("");
        try {
          const terms = {
            principal: parseAmount(principal, market.loanDecimals).toString(),
            collateral: parseAmount(collateral, market.collateralDecimals).toString(),
            interest: parseAmount(interest, market.loanDecimals).toString(),
            durationDays: Number(days),
            expiresAt: Math.floor(new Date(expiry).getTime() / 1000),
          };
          const responseBy = Math.floor(new Date(deadline).getTime() / 1000), now = Date.now() / 1000;
          if (
            BigInt(terms.principal) <= 0n || BigInt(terms.collateral) <= 0n
            || BigInt(terms.principal) + BigInt(terms.interest) >= 1n << 256n
            || !Number.isSafeInteger(terms.durationDays) || terms.durationDays < 1 || !/^\d+$/.test(days)
            || !Number.isSafeInteger(terms.expiresAt) || !Number.isSafeInteger(responseBy) || responseBy <= now
            || responseBy >= Math.min(sourceExpiry, terms.expiresAt)
          ) throw new Error("Use positive amounts, whole days and a respond-by time before both offer expiries.");
          setReview({ terms, responseBy });
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : "Check your terms.");
        }
      }}
    >
      <fieldset disabled={disabled} onChange={() => setReview(null)}>
        <legend>Your proposed terms</legend>
        <div className="p2p-form-grid">
          {([
            ["USDG to receive", principal, setPrincipal],
            ["Collateral · " + market.collateralSymbol, collateral, setCollateral],
            ["Duration · whole days", days, setDays],
          ] as const).map(([label, value, set], index) => (
            <div className="turret-labeled-field" key={label}>
              <FieldLabel htmlFor={`${id}-${index}`} topic={(["principal", "collateral", "duration"] as LoanHelpTopic[])[index]!} helpLabel={label}>{label}</FieldLabel>
              <input
                id={`${id}-${index}`}
                value={value}
                inputMode={index === 2 ? "numeric" : "decimal"}
                required
                onChange={(e) => set(e.target.value)}
              />
            </div>
          ))}
          <div className="turret-labeled-field">
            <FieldLabel htmlFor={`${id}-replacement-expiry`} topic="expiry" helpLabel="Accept replacement before">Accept replacement before</FieldLabel><input id={`${id}-replacement-expiry`}
              type="datetime-local"
              value={expiry}
              required
              onChange={(e) => setExpiry(e.target.value)}
            />
          </div>
          <div className="turret-labeled-field">
            <FieldLabel htmlFor={`${id}-respond-by`} topic="response" helpLabel="Respond to proposal by">Respond to proposal by</FieldLabel><input id={`${id}-respond-by`}
              type="datetime-local"
              value={deadline}
              required
              onChange={(e) => setDeadline(e.target.value)}
            />
          </div>
        </div>
        <LoanInterestField model={interestModel} duration={days} decimals={market.loanDecimals} disabled={disabled} onChange={() => setReview(null)} />
      </fieldset>
      <p className="p2p-help">
        Dates use your local timezone ({Intl.DateTimeFormat().resolvedOptions().timeZone}). The loan starts only when
        the borrower accepts the funded offer.
      </p>
      {error && <p role="alert" className="p2p-feedback">{error}</p>}
      {review
        ? (
          <>
            <NegotiationTerms original={original} proposed={review.terms} market={market} />
            <p className="p2p-help">
              Respond by{" "}
              {displayDate(review.responseBy)}. Only the two participants can read this negotiation through the app.
              Funded offers have public onchain terms.
            </p>
            <button
              type="button"
              className="p2p-button"
              disabled={disabled}
              onClick={() => void onSubmit(review.terms, review.responseBy)}
            >
              Sign and send proposal
            </button>
          </>
        )
        : <button className="p2p-button" disabled={disabled}>Review proposed terms</button>}
    </form>
  );
}
