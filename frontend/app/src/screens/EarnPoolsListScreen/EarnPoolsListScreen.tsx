import Link from "next/link";

export function EarnPoolsListScreen() {
  return (
    <div className="rusd-earn-screen">
      <section className="rusd-earn-hero">
        <div className="rusd-earn-message">
          <h1>USDG liquidity is supplied by the vault owner.</h1>
          <p>
            Public liquidity deposits are not enabled in the Dockyard MVP. Borrowers draw existing USDG against
            supported Stock Tokens.
          </p>
          <Link className="rusd-earn-learn" href="/">
            View Stock Token markets
          </Link>
        </div>
      </section>
    </div>
  );
}
