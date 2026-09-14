import { useId, type ReactNode } from "react";
import { IconInfo, RootEntryPoint, Tooltip } from "@turret/uikit";
import "./field-info.css";

export const loanHelp = {
  collateralToken: "Choose the token you will pledge for the loan. It stays in your wallet until you accept a funded offer.",
  principal: "The USDG the borrower receives when the loan is accepted. Interest is added to this amount when calculating repayment.",
  collateral: "The number of tokens the borrower pledges, not their USDG value. If the final repayment deadline is missed, the lender can claim this collateral.",
  interest: "The extra USDG owed to the lender for the whole loan. Enter an amount or a percentage of the amount borrowed. This is not a yearly rate. Early repayment still owes the full interest.",
  duration: "How many days the borrower has to repay after accepting the funded offer onchain. A 24-hour grace period follows. Publishing a request does not start this clock.",
  expiry: "The last time these terms can be accepted. For a request, this is when the listing closes. It is separate from the repayment deadline and does not shorten a loan that has already started. Times use your local timezone.",
  repayment: "The amount borrowed plus the agreed interest. The borrower owes this full USDG amount even when repaying early.",
  response: "The deadline for the other person to respond to your proposal. It must be before both offer expiries. It does not start or extend the loan.",
  visibility: "A public offer can be accepted by an eligible borrower. A private offer can only be accepted by the wallet address you choose.",
  borrower: "Only this wallet can accept the private offer. Check the full address before funding it.",
  nft: "This exact NFT is the collateral. It is held in the contract during the loan. After repayment the borrower can withdraw it; after default the lender can claim the entire NFT.",
  poolStatus: "Open means this pool is enabled. Whether you can borrow also depends on available USDG, your collateral and the current market checks.",
  pricing: "These are estimates, not a guaranteed sale or a recommended loan amount. A reference price can differ from the USDG you could receive by selling the collateral.",
  lenderApr: "Estimated yearly USDG interest at the pool’s current usage, after protocol fees. Actual returns depend on borrowing, repayments and losses. TURRET rewards are separate.",
  utilization: "The share of pool funds currently lent to borrowers. Higher usage leaves less USDG available for withdrawals.",
  shares: "Your shares represent your stake in the lending pool. Their USDG value changes with interest and losses. Withdrawing USDG also requires available pool liquidity.",
  withdrawable: "The USDG your shares can currently withdraw under the pool’s cash and withdrawal limits. This is a quote, not a reservation, and can change before confirmation.",
  unavailable: "This part of your position cannot currently be withdrawn. Funds may still be on loan, or market checks may limit withdrawals. There is no guaranteed date when it becomes available.",
  position: "The current estimated USDG value of your shares. It can include unpaid interest and can fall after losses. It is not the amount guaranteed to be withdrawable now.",
  ltv: "Your debt as a percentage of the current collateral value used by the pool. It rises when debt grows or collateral value falls.",
  liquidation: "The loan-to-value level at which the pool can make your loan eligible for liquidation. Keep your LTV below it with room for price changes and interest.",
  borrowerApr: "The yearly rate used to calculate interest on outstanding pool debt. Unlike P2P total interest, this interest grows over time.",
  capacity: "The additional USDG currently available to borrow, subject to collateral limits, pool cash and market checks. This can change before your transaction confirms.",
  cash: "USDG currently held as cash in this pool. Some may be unavailable for borrowing or withdrawal because other limits and market checks apply.",
  onLoan: "USDG principal currently borrowed from this pool. It is not available as cash until liquidity returns, for example through repayment.",
  poolCollateral: "Tokens deposited in the pool contract to secure your loan. Their value can change. Repaying the debt lets you withdraw collateral, subject to the token’s transfer rules.",
  poolDebt: "The USDG you currently owe, including interest accrued so far. More interest may accrue before your repayment transaction confirms.",
} as const;
export type LoanHelpTopic = keyof typeof loanHelp;

/** Use the platform tooltip and portal root inside the current surface, including native dialogs. */
export function FieldInfo({ label, topic }: { label: string; topic: LoanHelpTopic }) {
  const id = useId();
  return <span className="turret-field-info"><RootEntryPoint>
    <Tooltip id={id} opener={({ buttonProps, setReference, visible }) => <button
      {...buttonProps} ref={setReference} type="button" className="turret-info-trigger"
      aria-label={`About ${label}`} aria-expanded={visible} aria-describedby={visible ? id : undefined}>
      <IconInfo size={16} />
    </button>}><p>{loanHelp[topic]}</p></Tooltip>
  </RootEntryPoint></span>;
}

export function FieldLabel({ htmlFor, children, topic, helpLabel }: {
  htmlFor: string; children: ReactNode; topic: LoanHelpTopic; helpLabel: string;
}) {
  return <span className="turret-field-label"><label htmlFor={htmlFor}>{children}</label><FieldInfo label={helpLabel} topic={topic} /></span>;
}

export function TermLabel({ children, topic, helpLabel }: { children: ReactNode; topic: LoanHelpTopic; helpLabel: string }) {
  return <span className="turret-term-label"><span>{children}</span><FieldInfo label={helpLabel} topic={topic} /></span>;
}
