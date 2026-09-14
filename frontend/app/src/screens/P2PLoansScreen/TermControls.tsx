import { FieldLabel } from "../../comps/FieldInfo/FieldInfo";
import { useState } from "react";
import type { CSSProperties } from "react";
import type { OfferErrors } from "./offerValidation";
import { ratioText, safeAmount, scaledCollateral } from "./termMath";

const trackStyle = (value: number, min: number, max: number) =>
  ({ "--p2p-range-fill": `${Math.max(0, Math.min(100, (value - min) / (max - min) * 100))}%` }) as CSSProperties;

export function CollateralControls(
  { principal, collateral, interest, symbol, loanDecimals, collateralDecimals, onPrincipal, onCollateral, errors = {} }:
    {
      principal: string;
      collateral: string;
      interest: string;
      symbol: string;
      loanDecimals: number;
      collateralDecimals: number;
      onPrincipal: (value: string) => void;
      onCollateral: (value: string) => void;
      errors?: Pick<OfferErrors, "principal" | "collateral">;
    },
) {
  const [anchor, setAnchor] = useState(collateral);
  const [percent, setPercent] = useState(100);
  const principalUnits = safeAmount(principal, loanDecimals);
  const collateralUnits = safeAmount(collateral, collateralDecimals);
  const interestUnits = safeAmount(interest, loanDecimals);
  const hasAmounts = principalUnits !== null && principalUnits > 0n
    && collateralUnits !== null && collateralUnits > 0n;
  const loanRatio = hasAmounts ? ratioText(principalUnits, loanDecimals, collateralUnits, collateralDecimals) : null;
  const repaymentRatio = hasAmounts && interestUnits !== null
    ? ratioText(principalUnits + interestUnits, loanDecimals, collateralUnits, collateralDecimals)
    : null;
  const anchorUnits = safeAmount(anchor, collateralDecimals);
  const canAdjust = anchorUnits !== null && anchorUnits > 0n;
  return (
    <div className="p2p-amount-controls">
      <div className="p2p-form-grid">
        <div>
          <FieldLabel htmlFor="p2p-field-principal" topic="principal" helpLabel="loan amount">Loan amount · USDG</FieldLabel>
          <input
            id="p2p-field-principal"
            name="principal"
            inputMode="decimal"
            value={principal}
            aria-invalid={!!errors.principal}
            aria-describedby={errors.principal ? "p2p-field-principal-error" : undefined}
            onChange={(event) => onPrincipal(event.target.value)}
            placeholder="0"
          />
          {errors.principal && <p className="p2p-field-error" id="p2p-field-principal-error">{errors.principal}</p>}
        </div>
        <div>
          <FieldLabel htmlFor="p2p-field-collateral" topic="collateral" helpLabel="collateral required">Collateral required · {symbol}</FieldLabel>
          <input
            id="p2p-field-collateral"
            name="collateral"
            inputMode="decimal"
            value={collateral}
            aria-invalid={!!errors.collateral}
            aria-describedby={errors.collateral ? "p2p-field-collateral-error" : undefined}
            onChange={(event) => {
              onCollateral(event.target.value);
              setAnchor(event.target.value);
              setPercent(100);
            }}
            placeholder="0"
          />
          {errors.collateral && <p className="p2p-field-error" id="p2p-field-collateral-error">{errors.collateral}</p>}
        </div>
      </div>
      <div className="p2p-adjustment">
        <div className="p2p-range-heading">
          <label htmlFor="p2p-collateral-range">Adjust collateral</label>
          <span>Loan amount stays fixed</span>
        </div>
        <input
          id="p2p-collateral-range"
          className="p2p-range"
          type="range"
          min="25"
          max="200"
          step="1"
          value={percent}
          disabled={!canAdjust}
          style={trackStyle(percent, 25, 200)}
          aria-valuetext={canAdjust ? `${collateral} ${symbol} required` : "Enter collateral first"}
          aria-describedby="p2p-collateral-range-help"
          onChange={(event) => {
            const next = Number(event.target.value);
            const amount = scaledCollateral(anchor, collateralDecimals, next);
            if (amount !== null) {
              setPercent(next);
              onCollateral(amount);
            }
          }}
        />
        <div className="p2p-range-ends" aria-hidden="true">
          <span>Less collateral</span>
          <span>More collateral</span>
        </div>
        <p className="p2p-help" id="p2p-collateral-range-help">
          {canAdjust
            ? "Drag to fine-tune, or type any exact collateral amount above."
            : "Enter a collateral amount to adjust it with the slider."}
        </p>
        <div className="p2p-backing" aria-label="Agreed loan per collateral token">
          <div className="p2p-backing-token">
            <span className="p2p-token-mark">{symbol}</span>
            <span>Each 1 {symbol} backs</span>
          </div>
          <dl>
            <div>
              <dt>Loan</dt>
              <dd>{loanRatio === null ? "—" : `${loanRatio} USDG`}</dd>
            </div>
            <div>
              <dt>Repayment</dt>
              <dd>{repaymentRatio === null ? "—" : `${repaymentRatio} USDG`}</dd>
            </div>
          </dl>
        </div>
        <p className="p2p-help p2p-ratio-note">
          {hasAmounts
            ? "Agreed amounts per token, not its market value. More collateral lowers the USDG lent per token."
            : "Enter both amounts to compare the USDG lent and repaid per token."}
        </p>
      </div>
    </div>
  );
}

