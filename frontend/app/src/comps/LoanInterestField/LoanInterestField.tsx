import { FieldLabel, TermLabel } from "../FieldInfo/FieldInfo";
import { useId, useState } from "react";
import { formatUnits } from "viem";
import { resolveInterest, switchInterestUnit, type InterestInput, type InterestUnit } from "./interest";
import "./loan-interest-field.css";

export function useLoanInterest(principal: string, decimals: number, initial = "0") {
  const [input, setInput] = useState<InterestInput>({ unit: "USDG", value: initial });
  const resolved = resolveInterest(principal, decimals, input);
  return { input, ...resolved,
    setValue: (value: string) => setInput({ unit: input.unit, value }),
    setUnit: (unit: InterestUnit) => setInput(switchInterestUnit(input, unit, principal, decimals)),
    setAmount: (value: string) => setInput({ unit: "USDG", value }),
  };
}

export function LoanInterestField({ model, decimals, disabled = false, onChange, error, inputId, showSummary = true }: {
  model: ReturnType<typeof useLoanInterest>; duration: string; decimals: number; disabled?: boolean;
  onChange?: () => void; error?: string; inputId?: string; showSummary?: boolean;
}) {
  const id = useId(), fieldId = inputId ?? `${id}-interest`;
  const [blurred, setBlurred] = useState(false);
  const message = error || (blurred ? model.error : "");
  const selected = model.input.unit;
  const needsPrincipal = selected === "USDG" && model.amount !== null && model.amount > 0n
    && (model.principal === null || model.principal <= 0n);
  const approximate = selected === "%" && !!model.input.exactRate && model.percent.startsWith("≈")
    || selected === "%" && model.percent.startsWith("<");
  return <div className="loan-interest-field">
    <FieldLabel htmlFor={fieldId} topic="interest" helpLabel="total interest">Total interest · {selected}</FieldLabel>
    <div className="loan-interest-input-row">
      <input id={fieldId} name="interest" inputMode="decimal" value={model.input.value} required disabled={disabled}
        aria-invalid={!!message} aria-describedby={`${id}-help${message ? ` ${id}-error` : ""}`}
        onFocus={() => setBlurred(false)} onBlur={() => setBlurred(true)} onInvalid={() => setBlurred(true)}
        onChange={event => { model.setValue(event.target.value); onChange?.(); }} />
      <div className="loan-interest-units" role="group" aria-label="Interest input unit">
        {(["USDG", "%"] as const).map(unit => <button key={unit} type="button"
          className={`p2p-button${selected === unit ? "" : " p2p-secondary"}`}
          aria-pressed={selected === unit} disabled={disabled || (unit === "%" && needsPrincipal)}
          onClick={() => { model.setUnit(unit); onChange?.(); }}>{unit}</button>)}
      </div>
    </div>
    <p className="loan-interest-help" id={`${id}-help`}>
      {selected === "%" ? "% of the loan amount for the full term, not per year." : "USDG interest for the full loan term."}
      {" "}Early repayment costs the same.
    </p>
    {needsPrincipal && <p className="loan-interest-help">Enter a loan amount to convert this interest to a percentage.</p>}
    {message && <p className="loan-interest-error" id={`${id}-error`} role="alert">{message}</p>}
    {approximate && <p className="loan-interest-help">The percentage is approximate. Your exact USDG terms are preserved until you edit it.</p>}
    {model.rounded && !message && <p className="loan-interest-help">Interest is rounded down to {decimals} decimal places.</p>}
    {showSummary && <LoanRepaymentSummary model={model} decimals={decimals} />}
  </div>;
}

export function LoanRepaymentSummary({ model, decimals }: { model: ReturnType<typeof useLoanInterest>; decimals: number }) {
  return <dl className="loan-interest-summary" aria-label="Repayment breakdown" aria-live="polite">
      <div><dt><TermLabel topic="interest" helpLabel="total interest">Total interest{model.percent !== "—" ? ` · ${model.percent} for the full term` : ""}</TermLabel></dt>
        <dd>{model.amount === null ? "—" : `${formatUnits(model.amount, decimals)} USDG`}</dd></div>
      <div><dt><TermLabel topic="repayment" helpLabel="borrower repayment">Borrower repays</TermLabel></dt><dd>{model.total === null ? "—" : `${formatUnits(model.total, decimals)} USDG`}</dd></div>
    </dl>;
}
