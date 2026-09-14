import type { Metadata } from "next";
import { Logo } from "@/src/comps/Logo/Logo";
import { PreviewBottomBar } from "@/src/comps/AppLayout/PreviewBottomBar";
import "./terms.css";

export const metadata: Metadata = {
  title: "Terms of use | Turret",
  description: "Terms for using the Turret lending interface.",
  alternates: { canonical: "https://turret.capital/terms" },
};

export default function TermsPage() {
  return (
    <div className="rusd-shell">
      <header className="rusd-topbar">
        <div className="rusd-frame rusd-topbar-inner">
          <a className="rusd-brand-link" href="/" aria-label="Turret home"><Logo /></a>
          <a className="rusd-text-link" href="/">Back to app</a>
        </div>
      </header>
      <main className="rusd-frame turret-terms">
        <article>
          <h1>Terms of use</h1>
          <p className="turret-terms-date">Last updated: September 9, 2026</p>
          <p>These terms apply to your use of the Turret website and lending interface. By using the interface, you agree to these terms. If you do not agree, do not use it.</p>

          <h2>Using Turret</h2>
          <p>Turret provides an interface for collateral borrowing and lending through smart contracts. Turret is independent and does not imply endorsement by Robinhood or any token issuer. You must be legally able to enter into these terms and use the service in your jurisdiction. You are responsible for complying with applicable laws and any tax obligations arising from your activity.</p>

          <h2>Your wallet and transactions</h2>
          <p>You are responsible for securing your wallet, private keys and recovery phrase, and for the approvals and transactions you authorize. Check the network, token addresses, amounts, permissions and loan terms before signing. Confirmed blockchain transactions generally cannot be reversed through the interface. See the <a href="https://ethereum.org/security/">Ethereum wallet security guide</a> for practical precautions.</p>
          <p>Collateral and supplied funds may be held by smart contracts under the terms of your chosen market or loan. Keep enough gas to manage your positions. Closing the website or disconnecting your wallet does not cancel a loan, revoke an approval or withdraw funds.</p>

          <h2>Loan terms and costs</h2>
          <p>Review the interest, fees, collateral requirements, liquidation conditions and repayment deadline for each transaction. You are responsible for network fees, including fees on failed transactions. A proposal or displayed estimate does not guarantee that a loan will be funded or a transaction will execute.</p>
          <p>These website terms do not change an existing loan’s on-chain repayment obligations. A website outage, missed notification or unavailable price does not by itself extend a repayment deadline.</p>

          <h2>Risks and information</h2>
          <p>Borrowing and lending can result in partial or total loss of assets. Pooled loans can be liquidated; a defaulted P2P loan can transfer all pledged collateral to the lender. Lenders may receive less than they supplied, and withdrawals depend on the applicable contract and available liquidity.</p>
          <p>Read the <a href="https://docs.turret.capital/platform/risks">Risk disclosures</a> before committing funds. Prices, rates, quotes and returns shown in the interface can change or be unavailable. Information on this website is for general information and is not personal investment, legal or tax advice. No return or preservation of capital is promised.</p>

          <h2>Availability and third parties</h2>
          <p>Turret is in open beta. Features may change, be interrupted or become unavailable. Wallets, networks, price feeds, token issuers and other third-party services have their own risks and terms. Token restrictions and smart contract faults can affect access to funds and settlement. Do not rely on the interface or alerts as your only way to track a position.</p>

          <h2>Acceptable use</h2>
          <p>Do not use the interface for unlawful activity, fraud or impersonation. Do not interfere with the service, attempt unauthorized access to other users’ data, or use the interface to harm other users.</p>

          <h2>Updates and contact</h2>
          <p>Updates to these terms will be published on this page with a revised date. Review the current terms before using the interface. Nothing in these terms excludes rights that cannot lawfully be excluded.</p>
          <p>For questions, contact <a href="mailto:support@turret.capital">support@turret.capital</a>.</p>
        </article>
      </main>
      <PreviewBottomBar interactive />
    </div>
  );
}
