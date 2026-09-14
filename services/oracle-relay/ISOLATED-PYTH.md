# CASHCAT / USDG signed-price preflight

This read-only probe tests the candidate Pyth price path for isolated lending. It does not deploy contracts, publish a report, operate a relay, or approve a market. PONS has no configured feed here.

Run from the repository root with the following variables supplied through the environment, not command-line arguments:

- `PYTH_API_KEY`: access to both CASHCAT/USD (3441) and USDG/USD (232).
- `ALCHEMY_RPC_URL`: Robinhood mainnet RPC, chain 4663.
- `ISOLATED_PYTH_VERIFIER_CODE_HASH`: independently reviewed runtime hash of the Pyth verifier. The probe rejects a mismatch; it does not trust a newly observed hash automatically.
- `ISOLATED_PYTH_PREFLIGHT_CALLER`: a public address with enough native balance for the simulated verification fee. No private key is used, and `eth_call` spends no funds.

```sh
node services/oracle-relay/src/isolated-pyth-preflight.mjs
```

The probe resolves exact catalog symbols and IDs, decodes the signed bytes, checks token decimals, and calls Pyth's verifier at a pinned block. The verified payload must match those bytes exactly. It rejects stale or future RPC heads, changed block hashes, changed verifier runtime, and verification fees above 1 gwei. Provider response bodies, credentials, and RPC URLs are excluded from error output.

Its quote matches `DockyardPythUsdRatioFeed`: collateral price minus its confidence estimate, divided by USDG price plus its confidence estimate. It checks report age, underlying price age, regular session, minimum publishers and pair timestamp alignment. Zero confidence is accepted, as in the contract. Confidence estimates are not guaranteed price bounds.

Exit codes:

- `0`: signatures and candidate quote checks pass at the pinned block and the probe's completion time. This is permission to continue adapter testing, not production approval.
- `2`: authentication passed, but the candidate quote is unavailable.
- `1`: configuration, access, metadata, RPC, signature verification or snapshot checks failed.

Output always leaves `marketApproved`, `exactTokenBindingReviewed` and `publisherIndependenceReviewed` false. Token runtime hashes are observations, not completed token-behavior reviews. The verifier's proxy upgrade authority also remains a trust dependency.

## Verification

```sh
node --test services/oracle-relay/test/*.test.mjs
cd contracts
forge test --skip script --match-contract '^DockyardPythUsdRatioFeedTest$'
cd ..
node --test services/oracle-relay/test/isolated-pyth.integration.mjs
```

The integration test starts a fresh loopback Anvil, deploys the actual hub and ratio adapter, and uses an ephemeral signature-verifying fixture. It compares the preflight quote with Solidity for normal prices, USDG depeg and recovery; both reject closed sessions, wide confidence and stale underlying prices. Forged signatures fail, and the preflight leaves the caller's nonce unchanged. Test-only contract code is installed at canonical addresses on that fresh local chain, never on a fork or remote network.

These tests do not establish access to live CASHCAT or USDG signed reports. The most recent account check rejected both requests. The catalog is accessible without a sending entitlement; finding a symbol there does not resolve that access failure.

Neither a successful probe nor this adapter fixes the primary TWAP's measured liquidation delay. A working oracle design, feed identity and independence review, an operating publication service, liquidation funding and end-to-end production checks are still required.
