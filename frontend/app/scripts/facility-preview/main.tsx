import { createRoot } from "react-dom/client";
import { useState } from "react";
import { P2PAppLayout } from "../../src/p2p/P2PAppLayout";
import { FacilityWorkspace } from "../../src/facilities/FacilityWorkspace";
import { drawAmounts, quoteDigest, ZERO_ADDRESS, ZERO_HASH, type SignedQuote } from "../../src/facilities/quotes.mjs";
import type { FacilityMarket } from "../../src/facilities/ui-model";
import type { DrawReview, FacilityClient } from "../../src/facilities/client";
import "../../src/app/brand.css";
import "../../src/app/turret-fonts.css";
import "../../src/screens/P2PLoansScreen/p2p.css";

const lender = "0x1111111111111111111111111111111111111111", borrower = "0x2222222222222222222222222222222222222222";
const market: FacilityMarket = { chainId: 4663, address: "0x3333333333333333333333333333333333333333", lender,
  loanToken: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168", collateralToken: "0x020bfC650A365f8BB26819deAAbF3E21291018b4",
  feeRecipient: "0x4444444444444444444444444444444444444444", feeBps: "1000", vaultImplementation: "0x5555555555555555555555555555555555555555",
  runtimeHash: ZERO_HASH, vaultImplementationHash: ZERO_HASH, collateralSymbol: "CASHCAT", collateralDecimals: 18, loanDecimals: 6, startBlock: "0" };
const query = new URLSearchParams(location.search), view = query.get("view") ?? "borrow", state = query.get("state") ?? "funded";
const account = view === "lend" ? lender : borrower, now = BigInt(Math.floor(Date.now() / 1000));
const quote = (nonce: string, days: number, interest: string): SignedQuote => ({ schemaVersion: 1, chainId: 4663, facility: market.address, signature: "0x",
  quote: { epoch: "1", nonce, borrower: ZERO_ADDRESS, capacity: "300000000", minDraw: "1000000", collateralForCapacity: "600000000000000000000", interestForCapacity: interest,
    duration: String(days * 86400), validAfter: String(now), expiresAt: String(now + 600n) } });
const quotes = [quote("1", 7, "15000000"), quote("2", 14, "24000000")];
const client = {
  reviewDraw: async (envelope: SignedQuote, principal: bigint): Promise<DrawReview> => ({ envelope, account, digest: quoteDigest(envelope), ...drawAmounts(envelope, principal, 1000n),
    maxDraw: 300_000000n, minDraw: 1_000000n, availableCapital: 300_000000n, checkedAt: Date.now(), blockNumber: 1n, blockHash: ZERO_HASH,
    feeBps: 1000n, collateralBalance: 1000n * 10n ** 18n, allowance: 0n, nativeBalance: 1n }),
  fundingState: async () => ({ idleCash: 500_000000n, cash: 500_000000n, activePrincipal: 200_000000n, unresolvedDefaultPrincipal: 0n, epoch: 1n, quoteSigner: ZERO_ADDRESS, paused: false, timestamp: now,
    limits: { maxExposure: 1000_000000n, minDraw: 1_000000n, maxDraw: 300_000000n, minDuration: 86400n, maxDuration: 30n * 86400n, maxQuoteLifetime: 3600n, minCollateralPerPrincipalWad: 10n ** 30n, minInterestBps: 100n } }),
  loanPage: async () => ({ rows: [{ id: 1n, borrower, principal: 100_000000n, interest: 5_000000n, dueAt: now + 7n * 86400n, status: state === "repaid" ? 2 : 1 }], checked: 1, nextCursor: null }),
  loan: async () => ({ id: 1n, borrower, vault: market.vaultImplementation, principal: 100_000000n, collateralAmount: 200n * 10n ** 18n, interest: 5_000000n, dueAt: now + 7n * 86400n,
    lenderCredit: 104_500000n, feeCredit: 500000n, collateralCredit: state === "repaid" ? 200n * 10n ** 18n : 0n, status: state === "repaid" ? 2 : 1, defaultAcknowledged: false }),
  loanCredits: async () => ({ repayment: state === "repaid" ? 104_500000n : 0n, fee: state === "repaid" ? 500000n : 0n, collateral: state === "repaid" ? 200n * 10n ** 18n : 0n, blockNumber: 1n, blockHash: ZERO_HASH }),
  extension: async () => [ZERO_ADDRESS, 0n, 0n, 0n, 0n],
  transactions: { reconcile: async () => { throw new Error("Preview only. No wallet transactions are available."); } },
} as unknown as FacilityClient;
function Preview() {
  const [checkedAt, setCheckedAt] = useState(Date.now);
  return <P2PAppLayout activePage="borrow" network="Read-only preview" wallet={<span>Illustrative wallet</span>}>
    <div className="facility-preview-note">Local preview · illustrative amounts · no transactions. <a href="/?view=borrow">Borrow</a> · <a href="/?view=lend">Lend</a> · <a href="/?view=loans">My loans</a> · <a href="/?state=empty">Empty</a></div>
    <FacilityWorkspace market={market} client={client} account={account} provider={null} wrongChain={false} directory={{ checkedAt, capacity: state === "empty" ? 0n : 500_000000n,
      quotes: state === "empty" ? [] : quotes.map(envelope => ({ id: quoteDigest(envelope), envelope, availability: { status: "available", reason: null, borrowerEligible: true, capacity: 300_000000n, maxDraw: 300_000000n, minDraw: 1_000000n } })) }}
      loading={false} error={state === "error" ? "Current funding checks are unavailable. Refresh to try again." : null} refresh={() => setCheckedAt(Date.now())} connect={() => {}} preview initialTab={view === "lend" ? "lend" : view === "loans" ? "loans" : "borrow"} />
  </P2PAppLayout>;
}
createRoot(document.getElementById("root")!).render(<Preview />);
