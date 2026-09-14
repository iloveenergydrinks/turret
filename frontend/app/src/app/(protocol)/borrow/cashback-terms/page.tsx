import '@/src/borrower-cashback/cashback.css';
export const metadata = { title: 'Borrower cashback terms | Turret' };

export default function BorrowerCashbackTerms() {
  return <main className="dockyard-borrow">
    <article className="turret-borrower-cashback">
      <h1>Public borrower cashback</h1>
      <p><strong>Public enrollment opens September 11, 2026 at 17:00 UTC.</strong> The campaign budget is 1,000 USDG, with one shared 25 USDG cap per wallet. Eligible interest accrues for 30 days, ending October 11, 2026 at 17:00 UTC. Join the funded campaign before borrowing to qualify.</p>
      <h2>Who can participate</h2>
      <p>Enrollment is public and first come, first served in the supported USDG pool markets. Each wallet can reserve one shared 25 USDG allowance across all campaign markets, so the 1,000 USDG budget supports 40 fully reserved wallets. Enrollment requires a separate wallet transaction before borrowing. P2P and NFT loans and the operator/treasury wallets are excluded. Wallet limits do not establish unique people or prevent related-party lending.</p>
      <h2>What earns cashback</h2>
      <p>The rate is 50% of eligible interest paid, in USDG, up to the shared amount reserved for your wallet. Your contractual interest rate and repayment obligations stay unchanged. Cashback is paid separately.</p>
      <p>Only new principal borrowed after your enrollment starts is eligible. Interest must accrue during the campaign and be paid by its settlement deadline. Existing debt is excluded. Top-ups qualify only within the enrollment window. Principal repayments reduce eligible principal first; interest payments settle the oldest accrual first.</p>
      <p>A third party may repay your loan, but cashback belongs to the borrower. Liquidation-funded settlements, principal repayments and unpaid or written-off interest do not earn cashback. All repayments in a transaction that liquidates the same borrower in the same market are excluded.</p>
      <h2>Your funded cap and deadlines</h2>
      <p>An accepted enrollment reserves its entire maximum rebate in a separate USDG contract. The cap is shared across eligible borrowing by that wallet across all supported markets. It cannot be reduced after enrollment. Claims across different markets consume the same wallet cap. Unused slots are not released during the campaign. No funds are taken from lenders or earned staking rewards.</p>
      <p>Enrollment and eligible accrual run from September 11 to October 11, 2026 at 17:00 UTC. Pay eligible interest by November 10, 2026 at 17:00 UTC and claim by December 10, 2026 at 17:00 UTC. Interest paid after the accrual end can still qualify if it accrued while eligible and is paid by the settlement deadline. Claims expire after the claim deadline; remaining escrow funds can then return to the treasury.</p>
      <p>Campaign contract on Robinhood Chain (4663): <a href="https://robinhoodchain.blockscout.com/address/0x29eaa2065d521B6f3ffbaA3012805edc57314Ad6">0x29eaa2065d521B6f3ffbaA3012805edc57314Ad6</a>. The dev wallet funds the campaign and publishes allocations.</p>
      <h2>Verification and claims</h2>
      <p>Turret reviews confirmed loan receipts and publishes cumulative claim allocations. The distributor verifies those allocations, not the loan history itself. This introduces trust in the publisher's accounting. Published allocations remain usable until the claim deadline, and a new allocation cannot erase an older claim.</p>
      <p>Portfolio separates unpaid estimates, confirmed rebates, claimable rewards and amounts already claimed. Estimates are not an entitlement. Each published cumulative amount can be paid only once; anyone may submit a valid claim, but its USDG always goes to the enrolled borrower. Network fees are additional.</p>
      <p>Saved claims can be checked directly on chain if the rewards service is unavailable. Pausing new enrollment does not pause existing claims. Ordinary repayment and collateral management do not depend on the cashback service.</p>
      <a href="/borrow">Back to borrowing</a>
    </article>
  </main>;
}
