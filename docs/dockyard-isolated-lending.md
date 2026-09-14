# Isolated USDG lending: research implementation

`contracts/src/research/DockyardIsolatedCapitalPool.sol` implements the lender capital ledger. `DockyardIsolatedCreditEngine.sol` implements per-borrower collateral, debt, repayment and liquidation. Local borrower and lender screens connect to their transaction layer through an explicit deployment allowlist. No isolated deployment is configured in production, and these contracts do not share the live stock vault's funds. Do not fund or deploy them as a lending market: market-specific token, oracle and liquidation checks, parameter review and production integrations remain incomplete.

## Pool lending versus P2P

The proposed first version uses separately funded pools. A lender selects a collateral market and deposits USDG for shares. Approved borrowers use that pool's USDG. Interest increases the value of lender shares; recognized losses reduce it. One pool has no claim on another pool's funds.

Brian's fixed-term P2P proposal is a different contract. A lender would accept an individual loan's collateral, principal, rate, maturity and default terms. That needs offer signatures, cancellation and replay protection, collateral escrow, repayment allocation, expiry and a default-claim process. None of that is implemented here. P2P does not inherently require 70% LTV or fixed terms; those are product choices.

Taking collateral after default does not guarantee a discount to its current value. Lending 70 against collateral originally worth 100 can still lose money if that collateral falls to 50.

## What we take from Liquity

The local `ActivePool.sol` settles aggregate interest before debt changes. `StabilityPool.sol` calls that settlement before deposits and withdrawals. Dockyard uses the same accounting principle: checkpoint elapsed interest before capital enters or leaves, and before principal changes. A new lender therefore buys shares at a price that includes already-earned interest.

Liquity can mint BOLD interest and burn BOLD to offset liquidated debt. Dockyard cannot mint or burn USDG. Its unpaid interest is a receivable, not cash. `availableCash()` excludes received protocol fees, and lender withdrawals cannot exceed available cash. The research pool does not copy Liquity's Stability Pool or redistribute liquidated tokens to lenders.

The share implementation uses the repository's OpenZeppelin ERC-4626 base with a six-decimal virtual-share offset. See [OpenZeppelin's ERC-4626 documentation](https://docs.openzeppelin.com/contracts/4.x/erc4626) for the underlying share conversions and donation-attack mitigation. This is not a claim that Dockyard inherits an audit of that library or of Liquity.

## Implemented accounting

- Lenders deposit or mint shares and withdraw or redeem them, subject to cash availability and share allowances.
- A fixed contract address can draw principal up to an immutable principal limit. The collateral address labels the pool; the separate engine must actually enforce that collateral.
- A fixed per-pool APR accrues simple interest on outstanding principal. Fractional units carry between checkpoints, so repeated checkpoint calls do not erase interest. The test APR is not an approved market rate or lender APY.
- Share value includes unpaid interest net of its reserved revenue fee. Repayment replaces receivables with actual USDG without counting the same interest twice.
- Only received interest produces claimable protocol fees. Fees go to an immutable treasury. There is no owner withdrawal or arbitrary rescue function.
- Only the fixed engine can recognize losses. Both lost principal and lost interest reduce pool claims. Accurate, timely loss reporting is essential: unrecognized losses could otherwise fall on lenders who remain after others withdraw.
- Transfer balance checks reject taxed USDG transfers. They do not establish that PONS or CASHCAT are safe collateral.
- New deposits stop after total loss while worthless shares remain outstanding. Holders may redeem those shares for zero. Rebasing assets are unsupported.
- With debt outstanding, lender entry/exit and fresh capital draws stop if the engine is paused, pricing is unavailable or any loan is liquidation-eligible. Repayment, collateral top-ups and liquidation remain available subject to their own checks. The pool resumes capital operations when all outstanding loans are priceable and healthy. A debt-free pool permits withdrawals without an oracle read.
- The safety scan is bounded to 64 active borrowers. Closed loans release their slots. An immutable minimum debt prevents smaller initial loans and voluntary partial repayments that leave smaller balances; it does not prevent liquidation-created dust. Production values must cover keeper costs and account for slot-exhaustion attacks.

## Wallet transaction layer

`frontend/app/src/isolated-credit.ts` prepares transactions without signing or broadcasting them. It requires explicit engine, pool, collateral and oracle addresses plus reviewed runtime hashes, including canonical USDG. It checks chain 4663, token decimals, contract bindings and a fresh canonical block before returning data. Hash checks do not review token behavior or proxy upgrade authorities. Never construct this deployment object from arbitrary query parameters.

`readIsolatedMarket` returns accrued borrower debt, collateral, pool book value, available cash, lender shares, and the contract's current deposit/withdraw/redeem limits. An unavailable price is `null`, not zero or a healthy loan. Repayment and debt-free collateral exits remain preparable during oracle data outages and risk pauses, provided deployment bindings still match. Changed contract code blocks preparation and needs review.

`quoteLenderIntent` returns a user-reviewable minimum share receipt, maximum share burn, or minimum USDG return. The candidate slippage setting defaults to 0.5%, accepts 0–1%, and is not a reviewed market parameter. `depositWithMinShares`, `withdrawWithMaxShares` and `redeemWithMinAssets` enforce those limits atomically with a deadline no more than five minutes ahead. Ordinary ERC-4626 calls remain available for compatibility but do not enforce these quote limits. Surrendering worthless shares after complete loss uses the separate `redeemWorthless` intent; the UI must explain that no USDG is expected and obtain explicit confirmation.

`prepareIsolatedAction` supports lending, withdrawal, redemption, deposit-and-borrow, additional borrowing, collateral top-ups/withdrawal, partial repayment and full closure. It returns one simulated wallet step. Insufficient nonzero allowances first reset to zero, followed by an exact bounded approval. After each mined approval, prepare again with the same reviewed intent. A changed quote requires a new review; do not silently loosen its bounds. Full closure uses an explicit maximum repayment amount, which must cover accrued interest at execution.

The caller must still enforce wallet/chain identity immediately before signing, reject expired prepared steps, display gas and token limits, handle replacement/reverted receipts, and refresh balances only after confirmation. Preparation includes 25% gas-estimate headroom plus 50,000 units, capped at five million; these are candidate client limits, not a guarantee of transaction inclusion or execution. Simulation does not reserve liquidity or prevent a later price change.

`IsolatedMarketScreen` connects this layer to `/borrow?engine=<address>` and `/earn?engine=<address>`. `NEXT_PUBLIC_ISOLATED_MARKETS_JSON` defaults to `[]`; entries need the full `IsolatedDeployment` object and a canonical `CASHCAT` or `PONS` symbol/token pair. Duplicate symbols, overlapping engines/pools, malformed hashes and stock-vault overlap fail closed. The existing read-only deployment flag still takes precedence. Unknown or duplicate engine query parameters cannot open stock-vault controls. Legacy Liquity Earn routes remain inaccessible when isolated lending is enabled.

The screen distinguishes cash available now from estimated lender share value, which includes unpaid interest. Borrower APR is not presented as lender APY. Borrowers can review additional borrowing, collateral top-ups and withdrawals, partial repayment, or full closure with an explicit interest allowance. Each review is prepared again before signing. Approval receipts lead to another review, never an automatic deposit or loan. Engine-scoped borrower alert settings use the separate verified-service allowlist.

Before opening a wallet request, the screen stores public transaction metadata in local storage, keyed by chain, engine and wallet. A pending request blocks another action after a reload. Known hashes can be checked again after timeouts; an ambiguous wallet response requires the transaction hash from wallet activity. Recovery checks the account, target, calldata, value and confirmation block. Unrelated or older hashes cannot clear an unknown request. Confirmed wallet rejection clears the record. Storage failures before signing stop the request; corrupted records fail closed and need operator-assisted investigation. This browser journal is not an on-chain replay guard or a cross-device lock. Users must not operate the same loan concurrently from separate devices.

The local integration test uses fresh loopback Anvil, ephemeral wallets and mock assets/oracles with the actual engine and pool. It covers guarded lender entry/exit, bounded allowance reset, borrowing, partial repayment, interest accrual, paused/oracle-unavailable closure and full lender redemption. It also mines later timestamps than those used for preparation. Screen tests use mocked wallet clients; the visual fixture uses simulated balances and has no signing wallet. None of these checks moves production funds or verifies a deployed frontend lifecycle.

For repeatable desktop/mobile inspection, run `pnpm exec vite --config scripts/isolated-screen-preview/vite.config.mjs` from `frontend/app`, then open `http://127.0.0.1:3033/` or `/?mode=borrow`. `&long=1` exercises an 18-decimal collateral display. This fixture is outside application routes and is not a production configuration.

```sh
cd contracts
forge test --skip script --match-path 'test/research/*.t.sol' --fuzz-runs 1024
cd ../frontend/app
pnpm exec vitest run src/isolated-credit.test.ts src/isolated-market-config.test.ts src/screens/IsolatedMarketScreen/IsolatedMarketScreen.test.tsx
pnpm test:isolated-integration
pnpm exec tsc --noEmit
```

## Required before a market can open

1. Complete integration and review of the collateral engine. Its power to draw funds and recognize losses is a critical trust boundary. The current engine has immutable collateral and oracle configuration, binds its pool once, and starts with new borrowing paused. A proxy engine would add upgrade risk; use and verify the intended immutable deployment.
2. Extend aggregate/per-position reconciliation and capital-suspension tests beyond mocks. Current tests cover entry/exit suspension before liquidation and recovery through liquidation, repayment or top-up. Benchmark the bounded scan under cold storage reads and review failure and slot-exhaustion cases.
3. Verify deployed PONS/CASHCAT behavior. A matching name, getter or published launchpad source is not enough.
4. Test independent pricing and manipulation resistance. Successful pool observation reads are only a starting point, not an approved oracle.
5. Execute stressed token-to-USDG exits on a fork, including fees, thin liquidity, failed routes, stale prices and rapid price gaps. Set caps and LTV from those results.
6. Integrate the keeper, borrower alerts, lender withdrawal status and signed transaction previews. There is no withdrawal queue in this component; idle cash is first-come, first-served.
7. Complete security review and deployment-parameter review. No deployment script, production market, approved rate or guaranteed APY is included.

## Reproduce the local tests

From `contracts/`:

```sh
forge test --skip script --match-path 'test/research/DockyardIsolated*' --fuzz-runs 1024 -vv
forge test --skip script --match-path test/DockyardUSDGCreditVault.t.sol -vv
pnpm test:collateral-assessment
pnpm test:collateral-source
pnpm test:isolated-fork-runner
```

These unit and invariant tests use mocks. They do not prove executable PONS/CASHCAT liquidations or production readiness. The commands exclude deployment scripts; they are not a whole-repository build check.

The engine tests cover atomic opening and closure, partial repayment, debt-free collateral recovery with unavailable oracles, paused-risk operation, liquidation quotes, slippage, dust, insolvency and multi-borrower interest rounding. The invariant handler tries valid and invalid operations; expected reverts are caught, so its call count is not a count of successful loans or liquidations.

The invariant suite inherits only the deployment fixture, not the unit-test cases: it seeds an additional loan that would invalidate unit assertions expecting an empty system. The combined research run passes 53 unit/fuzz cases and one invariant at 500 runs × 50 handler calls. The existing stock-vault suite passes 18 tests; assessment, source-verification and fork-runner utilities pass 21 tests.

## Initial real-token fork evidence

At Robinhood Chain block **52855086**, all six cases in `DockyardIsolatedMarketsForkTest` passed without broadcast. Exact results are recorded in `contracts/utils/isolated-fork-observations.json`.

The lifecycle cases acquire real USDG and collateral through forked pools, fund a local lender pool, borrow, accrue two days of interest, repay and recover collateral. Full repayment and lender withdrawal also succeed while borrowing is paused and both mock feeds revert.

The liquidation cases sell synthetic whale inventory through actual DEX pool code to move prices, liquidate the local position, then sell all seized collateral through token → WETH → USDG. At approximately half the initial price, both tested loans repay all principal. At approximately one quarter of the initial price, the approximately 95 USDG loans leave **39.52 USDG of PONS-market loss** and **41.54 USDG of CASHCAT-market loss**. These tests verify loss recognition, not lender protection against price gaps.

Both oracle inputs are test-controlled spot prices. This does not validate a production oracle. The sampled liquidation exits return roughly 2.09–3.73 USDG more than the liquidator paid, after swap fees but **before gas**. Small positions, one block and one route do not establish production caps or keeper profitability. Larger positions, multiple borrowers, failed routes, stale pricing, manipulation, MEV and full transaction costs remain to be tested.

To reproduce, supply a private RPC through the environment and set `ISOLATED_FORK_BLOCK=52855086`, then run `pnpm test:isolated-fork` from `contracts/`. The runner requires an explicit block and RPC, redacts RPC credentials from captured output, and rejects skipped or incomplete tests. It never broadcasts. Do not put credentials into committed files or shell commands.

## V3 pricing adapter and its limits

`DockyardV3TwapFeed.sol` reads collateral/WETH and WETH/USDG history and returns an 18-decimal USDG-denominated price. It validates factory registration and token order, pins pool runtime hashes, requires current and historical liquidity, and rejects missing history, old observations, locked pools and excessive spot/TWAP divergence. It retains precision for token prices below one micro-USDG. It has no owner-controlled price setter.

Observation freshness uses the oldest actual pool write, not the time the adapter is called. Same-tick swaps may not write a new observation. A recent write is still not proof of independent economic price discovery. The adapter fails closed after the uint32 timestamp horizon rather than silently accepting wrapped timestamps.

Six additional fork cases at block 52855086 pass, recorded in `contracts/utils/isolated-twap-observations.json`. They verify history reads, stale rejection and real-swap spot safeguards. They also demonstrate a limitation: a trade-moved price held for 1801 seconds enters the average. In these scenarios the adapter accepted increases of 2.12% for CASHCAT and 2.08% for PONS. No arbitrage was simulated. The WETH used for trades is not an estimate of net attack cost.

**This remains one correlated source.** Two adapters with different windows on the same pools do not satisfy the engine's independent-source requirement. Spot divergence can suspend liquidation during a real price gap; the measured delays and losses are documented below. The adapter is not wired into production.

Run its local tests with `forge test --skip script --match-path test/research/DockyardV3TwapFeed.t.sol --fuzz-runs 1024 -vv`. With the same private RPC and pinned block environment as above, use `ISOLATED_FORK_SUITE=twap pnpm test:isolated-fork` for all six pricing fork cases. The exploratory thresholds are not approved production settings.

The adapter and its retained tick conversion use Uniswap's GPL-2.0-or-later mathematics, with pinned upstream references in the source and license text alongside it. The Solidity 0.8 port and Dockyard checks require their own review; upstream provenance is not an audit of this implementation.

## Atomic liquidation exits and keeper integration

`DockyardAtomicLiquidator.sol` combines USDG-funded liquidation, collateral → intermediate → USDG swaps and caller repayment in one transaction. It has an immutable engine and route, restricts swap callbacks to the active pinned pool, enforces full input consumption, clears its engine allowance, and checks exact token-balance changes. It returns unused funding and sale proceeds to the caller. Direct token donations are not withdrawable through this path; do not fund the executor directly.

A positive USDG profit floor and short deadline are required. The floor excludes native gas and L1 data fees; it does not guarantee net keeper profit. If either swap fails or the return floor is unmet, the entire liquidation rolls back, including insolvency loss recognition. That protects the caller from taking unwanted inventory but can leave a borrower awaiting liquidation when exits are uneconomic. Such delays remain a lender risk.

The four liquidation scenarios in the real-token fork suite now use this executor, and each also tests rollback with an unacceptable profit floor. All six lifecycle/exit cases pass at block 52855086. Separate local contract tests cover callbacks, route changes, partial fills, deadlines, donations and return-floor behavior.

The keeper supports an explicitly configured, runtime-pinned atomic executor. It simulates the full call and requires matching engine and executor receipt events before releasing inventory budget. Pending calls reserve the maximum spend; confirmed atomic exits still count toward daily repayment volume and gas budgets. The local Node integration tests both retained-collateral and atomic-sale modes, including restart recovery, gas-cap rejection and borrower collateral recovery. See `services/liquidator/ISOLATED.md` for configuration and limitations.

Local contract checks cover 100 unit/fuzz cases plus one invariant at 25,000 handler calls, including the Pyth ratio adapter below. The service results below include stock-mode regression tests. None proves that the undeployed markets or keeper are production-ready.

## Borrower alerts

The alert backend supports an explicitly configured isolated engine and pool, with separate wallet-signed consent and verified delivery channels. It reads debt including interest, uses the engine's liquidation threshold, and treats stale or unavailable pricing as unknown. Liquidation notifications require confirmed canonical events and consent recorded before their block. A slow scan cannot refresh readiness using an expired risk snapshot.

The current alert suite passes 41 tests, including stock-mode regression coverage. The keeper suite passes 43 tests. Both local EVM keeper scenarios now exercise six borrower risk states, cryptographic wallet authentication, verified email subscriptions and one deduplicated liquidation notification. Email delivery is captured by a fake sender; production inbox delivery is not tested.

Engine-specific frontend routing and borrower alert settings are implemented locally. Deployment and real provider delivery remain unverified. See `services/borrower-alerts/ISOLATED.md`. No isolated market or new alert service is live.

## Measured oracle-gap liquidation delays

`DockyardIsolatedOracleGapForkTest` combines the actual two-hop TWAP, credit engine and atomic token sale on the block 52855086 fork. Its secondary feed responds immediately to pool spot changes but remains test-controlled. It is not a verified independent source. All six cases pass; their assertions expose a release risk rather than certify safety.

With the exploratory 1,800-second window and 200-tick spot-deviation guard, the first executable liquidation quote appeared at 1,800 seconds after a roughly 49% price drop for both tokens. Quotes were sampled every 60 seconds, and small real swaps refreshed pool observations every 300 seconds. These trades slightly changed the prices. The approximately 95 USDG loans repaid in full in this single-drop scenario.

A second drop at 900 seconds left prices at approximately 22.40% of their initial value for CASHCAT and 23.91% for PONS. The first executable quote arrived at 2,700 seconds. The resulting lender losses were **44.211341 USDG for CASHCAT** and **40.797148 USDG for PONS**, including accrued debt. A separate snapshot comparison using an immediately correct mocked primary price repaid each loan without loss at the first drop. The actual adapter delay left the loans exposed to the second drop.

Without fresh pool writes, liquidation remained blocked after 3,601 seconds even though a full TWAP window had elapsed. Lender withdrawals also stayed blocked while the loan was unpriceable. The borrower could still repay, recover collateral, and thereby restore lender withdrawals without repairing either oracle. This verifies a recovery path, not a guaranteed time to liquidation. Uniswap's [oracle documentation](https://developers.uniswap.org/docs/protocols/v3/concepts/price-oracles) explains how historical observations and geometric averages work; Dockyard's stricter observation-age and spot-deviation rules create the specific blocking behavior measured here.

Reproduce with `ISOLATED_FORK_SUITE=gaps pnpm test:isolated-fork`, an explicit private RPC environment variable and pinned block 52855086. Results and limitations are recorded in `contracts/utils/isolated-oracle-gap-observations.json`. No contract or parameter was changed to bypass these guards. Production requires resolving independent pricing and acceptable liquidation behavior; larger/concurrent exits, sequencer outages, sustained manipulation, MEV and full transaction fees remain unverified.

## Pyth ratio adapter and access checks

Pyth's [reference catalog](https://pyth.dourolabs.app/v1/symbols) lists `Crypto.CASHCAT/USD` (Pro ID 3441) and `Crypto.USDG/USD` (Pro ID 232) as stable spot feeds. CASHCAT is also shown in [Pyth Terminal](https://app.pyth.com/explore/Crypto.CASHCAT%2FUSD). The September 2 catalog checks found no exact `Crypto.PONS/USD` entry, and the Hermes PONS search returned no matches. That does not establish that no provider can supply PONS pricing.

`DockyardPythUsdRatioFeed.sol` consumes the authenticated cache in `DockyardPythVerifier`. It divides the collateral's lower confidence estimate in USD by USDG's upper estimate in USD, returning an 18-decimal USDG price. It does not assume USDG is worth one dollar. Confidence is a provider uncertainty measure, not a guaranteed price bound; this valuation can differ from market mid-price and affects liquidation eligibility.

Both reports must be fresh, refer to recent underlying prices, use the regular crypto session, meet separate minimum publisher counts and remain within the permitted confidence ratio. Excessive report or source timestamp differences fail closed. The adapter pins the cache and upstream verifier runtime code, but an upstream proxy's upgrade authority remains a trust dependency. Deployment must verify feed IDs against the exact token contracts and assess publisher independence; catalog names alone are insufficient.

Twenty local tests cover signed-report parsing through the existing cache, tampering rejection, mixed decimals, sub-micro-USDG prices, conservative rounding, USDG price changes, stale source data, pair skew, publisher/confidence checks, and an isolated borrow/liquidate cycle. Signatures in these tests come from a local fixture signer. They do not verify live CASHCAT or USDG reports.

The existing authenticated Pyth account showed a Demo trial. Its key was tested against each feed and the pair; all three requests returned `PythEntitlementDenied`. No subscription was purchased or changed, and no key was saved or exposed. Evidence is in `contracts/utils/isolated-pyth-observations.json`.

This adapter is not deployed and does not by itself fix the 30–45-minute TWAP gap delay: the engine still requires both sources. Signed-feed access, token identity, source independence, continuous publication, liquidation policy and stressed exit validation remain release requirements. Fresh probes of the alternate CASHCAT/USDG and PONS/USDG pools did not return usable 1,800-second observations through the tested ABI; see `contracts/utils/isolated-alternate-pool-observations.json`. Their token balances are not a measure of safe liquidation size.
