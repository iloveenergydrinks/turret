# Proposed accelerated AAPL canary — September 6, 2026

The user requested a launch tomorrow. The proposed accelerated scope is a controlled, operator-funded production canary, starting with one 10 USDG loan and a 50 USDG aggregate principal ceiling. This changes the target date in `aapl-weekend-launch-criteria.md`; it does not establish technical readiness or remove the contract, pricing and liquidation gates. Public lender deposits and cap increases remain outside this accelerated proposal.

The earlier approximately 72-hour history recommendation was an operational evidence gate, not a protocol requirement. A Sunday launch necessarily lacks the coming reopening evidence and most of a full closure cycle. A small cap bounds principal exposure but does not make valuation correct or liquidation work. Accrued interest and operating costs are additional exposure.

## Required preparations

1. Provision a private QuickNode **Robinhood mainnet** endpoint (chain 4663), alongside the current Alchemy endpoint. Keep its credential in deployment secrets. Validate chain identity, same-block hashes, contract reads, real AAPL simulation with state overrides, historical state needed for fork tests, latency and rate limits before changing production settings. Require both providers where the admission/liveness policy needs corroboration; test disagreement and outage behavior.
2. Implement and review a separate oracle-capable AAPL market with onchain aggregate principal enforcement. The existing market's oracle binding cannot be replaced by a configuration flag. Keep existing positions/lender funds under their current rules.
3. Resolve the weekend price source and token-unit mapping. The current Kraken check relies on recent trades and is reporting stale trades; an independently validated active-book feed may support different freshness semantics, but merely extending the trade expiry is not a fix. Borrowing and liquidation need a coherent price policy, including source failures and later reopening.
4. Prepare designated operator collateral and USDG, keeper repayment reserves covering the full proposed exposure plus interest/incentives, and ETH for execution. Verify the actual accounts and balances before a funded test. No funds were moved by this preparation.
5. Pass the actual borrower/monitor/contract/keeper lifecycle on a mainnet fork: borrow, repay, full liquidation, stale price, sharp move, vanishing liquidity, RPC disagreement and chain interruption. The existing successful sale probes are not full liquidation lifecycle tests.
6. Prepare a monitored launch window, pause authority and a tested repayment/exit procedure. If any technical gate fails, the target slips; do not compensate by widening price freshness or bypassing checks.

## RPC recommendation and evidence

QuickNode officially documents Robinhood mainnet 4663 with HTTP/WebSocket and archive access:
https://www.quicknode.com/docs/robinhood/api-overview

At September 5, 2026 16:20 UTC, the documented QuickNode demo endpoint passed:
- `eth_chainId == 4663`;
- a recent pinned historical `eth_getCode` read (1,000 blocks back; not a deep-archive test);
- `eth_call` with both code and storage overrides, returning the expected storage value.

The official public Robinhood RPC also passed those probes. Robinhood explicitly describes that endpoint as rate limited and not recommended for production:
https://docs.robinhood.com/chain/connecting/

The demo and public endpoints have not been configured in production. Probe evidence is in `output/weekend-pilot/rpc-candidates.json`. A private paid/trial endpoint must pass its own workload tests; the demo result is not an SLA or production credential test.

QuickNode's published pricing at this check offers a one-month no-card trial with 10M API credits/15 requests per second, and Build at $49 monthly (an annual-billing discount is also displayed), 80M credits/50 requests per second. The operator has selected the free account for now; no paid plan or automatic upgrade is authorized. Check both total credits and peak requests, especially parallel simulation reads:
https://www.quicknode.com/pricing

A second RPC supplies another chain-data path. It does not create an independent stock price and cannot remove shared sequencer/network failures.

## Engine and pool arrangement

The proposed replacement is one capped AAPL lending market that can support qualified weekday and weekend borrowing. Loans remain in it continuously; there is no Friday/Monday transfer between engines.

It needs a new lending engine and its own USDG credit capital pool. The existing engine's oracle and stock-guard bindings are immutable, the pool's `creditEngine` is immutable, and the engine's `bindPool()` can run only once. Existing borrowers and lenders retain their current engine and pool. Any later consolidation requires an explicit migration with repayment/redemption constraints.

The existing AAPL/USDG Uniswap trading pool can remain the sale and observation venue if it passes the pricing and execution requirements. This proposal does not require creating a second Uniswap pool or splitting its liquidity. A replacement liquidation executor must bind the new engine because the present executor's engine binding is immutable.

## QuickNode private endpoint qualification — September 5

The operator supplied a working Robinhood mainnet HTTPS endpoint after the separate account-management key was rejected. Endpoint credentials are excluded from repository files and reports. No subscription was purchased or changed.

Evidence in `output/quicknode-pilot`:

- Five independent Alchemy/QuickNode block comparisons agreed on hashes and timestamps, with zero or one block of head skew.
- The full read-only AAPL observer passed on QuickNode alone, including exact runtime and proxy implementation pins and all four 10/50/100/1,000 USDG sale simulations.
- The production Linux/Node container selected QuickNode after a simulated primary failure, verified the exact AAPL contract bindings in about 6.2 seconds, and returned to Alchemy after recovery. No signing key was supplied to the test.
- The container's two-provider observer completed samples, enforced history authentication, and retained samples after worker restart. A pool-code read about one hour behind the current head also passed; this is not a comprehensive archive-depth test.
- 120 risk-monitor tests and 16 RPC/operations tests passed after the production observer timing repair.

The rollout is limited to `dockyard-stock-risk` (AAPL). Alchemy stays primary, and `KEEPER_FALLBACK_RPC_MAX_RPS=8` spaces QuickNode request starts, with a bounded queue and no additional transaction retries. The observer separately makes approximately three QuickNode requests per minute. Other markets, keeper services, quorum settings and lending policy are unchanged by this rollout.

Production qualification exposed false observer failures from its original three-block head-skew limit on this subsecond chain. The observer now starts chain-ID and latest-head requests concurrently and allows up to 40 blocks of head skew, matching the current risk-service default. Both providers must still return the exact requested common block number with matching hash and timestamp; the 30-second snapshot age and final onchain expiry checks are unchanged. Failed onchain collections report `corroborated: false`. This fixes observation behavior and does not change oracle expiry or loan admission. The production-host measurements are in `output/quicknode-pilot/remote-skew.json`.

At the configured five-second cycle, three health requests per cycle plus the observer's three per minute total up to roughly 39 requests/minute in steady operation. QuickNode lists 20 credits per ordinary Robinhood RPC method: approximately 1.12M credits/day or 33.7M/30 days at that cadence. A fresh 10M-credit allowance lasts about 8.9 days at that rate before failover, retries or other account usage; actual cycle duration can lower usage. The remaining account allowance and trial expiry have not been verified. Treat this as an immediate pilot budget, not an indefinitely free full backup. An exhausted endpoint may fail while Alchemy continues under the existing one-provider policy.
https://www.quicknode.com/api-credits

Production verification completed September 5 at 16:48 UTC for deployment `3c3e5feb-8d3c-4aff-8298-236a8f30a73a`: all 124 runtime files matched the release hashes, only the two intended RPC settings differed from the original configuration, two consecutive new observations were corroborated, risk liveness returned 200 with no incidents, and all four sale probes passed. History retains the earlier unsuccessful samples; it is not a continuous clean qualification period. Kraken trades remained stale, and the borrowing endpoint continued returning `market_closed`. See `output/quicknode-pilot/production-verification.json` for current rollout evidence; the earlier `output/weekend-pilot` release remains the historical initial-observer record.
