# P2P monitoring and recovery policy

Applies to the registered V1/V2 deployments. Existing loan terms and deployed Solidity are unchanged.

## New lending

The website checks the escrow runtime and token pair, token decimals and runtime hashes, standard implementation/beacon slots, implementation code hashes, positively supported pause/freeze checks, and escrow backing at a canonical block. Checks run while loading a market, before approving new exposure, and again before submitting creation or acceptance.

The expected backing is `USDG balance >= reservedPrincipal + totalCredits[USDG]` and `collateral balance >= lockedCollateral + totalCredits[collateral]`. Active disbursed principal is not an immediately withdrawable cash liability.

A change, deficit, active restriction, stale chain state or failed required read blocks creation and acceptance in the website. The explanation appears beside the affected action. **This is a frontend guard, not an additional onchain restriction.** Direct calls remain governed by the immutable contract. The guardian can pause new creation/acceptance onchain using the existing contract function when an operator has confirmed an incident.

The baseline at `frontend/app/public/p2p-token-baseline.json` records observed identities, not a completed security approval. Missing admin or restriction getters remain unknown. Never regenerate the baseline automatically after a mismatch; investigate the new implementation and requalify before approving a replacement. A proxy mechanism outside the observed standard slots, administrator behavior, and token reserve/issuer risk need exact-source review.

Run the operator check from the repository root:

```sh
node frontend/app/scripts/p2p-health.mjs --output /tmp/p2p-health.json
```

It uses `DOCKYARD_RPC_URL`, then `NEXT_PUBLIC_CHAIN_RPC_URL`, then the public Robinhood RPC. It sends no transactions. Exit 0 means all observed checks passed; exit 2 means one or more markets did not pass; exit 1 means the run could not complete. Output excludes upstream credentials. This command is a one-shot check, not a separately scheduled alert service.

For an explicitly reviewed new token baseline, `--capture /path/to/new-candidate.json` writes a new candidate with exclusive file creation. Compare it with the previous record and complete source/role qualification before replacing the release baseline. Never treat a token address or familiar ticker as sufficient qualification.

## Discovery and availability

The application server maintains an accepted-loan event index for registered markets. It scans acceptance/repayment/default events, checks canonical checkpoints, rolls back on reorgs and verifies active contract state. Cancelled incoming proposals do not consume active-loan discovery slots. Account history remains paginated separately.

Set `P2P_INDEX_DIRECTORY` to persistent service storage if available; the default `/tmp/turret-p2p-active-loans` is a rebuildable cache. Checkpoints use atomic writes. Startup and ongoing bounded warming do not depend on the borrower repeatedly loading old offer pages. A syncing, unavailable or capacity-limited result is never reported as a complete empty portfolio. The UI retains known active positions and offers direct market/loan-ID lookup. Stale retained positions are still revalidated before transactions.

Monitor service errors and index lag through `/api/p2p/active-loans?market=REGISTERED_ADDRESS&account=WALLET`; `complete`, `status`, `indexedThrough` and canonical block fields are explicit. The endpoint contains public chain data and sits behind the same website access policy. A valid result identifies and verifies returned loans; completeness still depends on the configured RPC and index infrastructure.

## Repayment and incident response

V1/V2 accept full repayment through the final deadline, inclusive. The final deadline is the accepted due date plus 24 hours. After it, repayment fails even before default is claimed. Anyone can finalize default, but collateral goes only to the agreed lender.

Token restrictions, chain outages, website outages and guardian pauses do not extend that deadline. Do not promise otherwise. Show UTC deadlines, encourage early repayment and preserve direct loan links. The loan view offers an iCalendar download with due/final-deadline events and reminders one day and one hour before the final deadline. Users must import it into their calendar; it is not an automatic subscription and does not update after settlement. A borrower may first withdraw their USDG credit and then repay; those are separate transactions, and a withdrawal alone does not settle the debt.

Health monitoring must not disable cancellation, expiry, repayment, default settlement or credit withdrawals. Token behavior may itself make a transfer fail. The frontend still checks the escrow identity and simulates the exact action. Do not hide existing markets or redirect users to a new escrow during an incident.

For a confirmed restriction, upgrade or deficit:

1. Record a canonical block, affected pairs, observed balances and current token implementation identities.
2. Suspend new exposure through the existing guardian policy when appropriate; preserve all recovery paths and accepted terms.
3. Explain which action is affected and whether the repayment deadline continues. Never claim a transfer succeeded without its receipt.
4. Investigate issuer/chain restoration and the exact implementation. A missing balance cannot be repaired by merely adjusting accounting credits.
5. Requalify before resuming new loans. Existing agreements have no retroactive extension or loss-sharing amendment.

## Outstanding external diligence

The monitoring baseline is implemented. Exact-source reproduction and exhaustive privileged-role mapping for USDG, the Robinhood beacon/token implementation, CASHCAT, PONS and INDEX remain incomplete. A code hash does not resolve that gap. The product has no commissioned independent audit from this implementation task. Use `docs/turret-p2p-audit-brief.md` for the review package; do not advertise this work as external certification.
