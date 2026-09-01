# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

People who already hold tokenized US equities and want dollar liquidity without selling their market exposure. They understand collateral, loan-to-value ratios, and liquidation risk, but should not need prior Liquity knowledge.

## Product Purpose

rUSD lets users deposit supported Stock Tokens into isolated vaults and borrow a dollar-denominated stablecoin against them. Success means a user can understand the risk, choose a stock, open or manage a position, and repay or redeem without confusing the tokenized exposure for ownership of the underlying share.

## Positioning

The product is a decentralized credit layer for tokenized equities: “Borrow against Wall Street.” Unlike a generic lending market, each supported equity has an isolated risk profile, dual-oracle controls, and its own liquidation backstop.

## Operating Context

Users connect an EVM wallet on Robinhood Chain, choose one supported Stock Token per position, deposit collateral, mint rUSD, monitor LTV and oracle state, manage debt, and optionally deposit rUSD into a Stability Pool. The initial set is AAPL, MSFT, GOOGL, AMZN, META, NVDA, AMD, ORCL, MU, and TSLA.

## Capabilities and Constraints

- Borrow, repay, add or withdraw collateral, liquidate, redeem, and use isolated Stability Pools.
- Portfolio or multi-collateral vaults are not part of this implementation.
- Leverage, governance staking, and inherited Liquity yield wrappers are disabled.
- Market closure, stale prices, corporate-action pauses, and liquidation risk must be explicit states.
- The UI may display rUSD while internal inherited contract identifiers still use BOLD.
- The product is independent and must not imply Robinhood endorsement or ownership of underlying shares.
- Production deployment remains gated by licensing, oracle simulations, independent audits, parameter review, and deployment verification.

## Brand Commitments

The product name is rUSD. The core message is “Borrow against Wall Street.” The identity should be minimal, narrow, friendly, and direct. It should inherit the approachable simplicity of Liquity V1 without copying its logo or becoming a corporate trading terminal. A new original logo and complete frontend visual world are required.

## Evidence on Hand

The repository contains the working Liquity-derived interaction flows, ten-branch Stock Token manifest, risk parameters, Robinhood token addresses, dual Chainlink feed configuration, and sandcastle documentation. There are no approved customer claims, usage metrics, audit claims, or final production deployment addresses.

## Product Principles

- Lead with the collateral-to-liquidity mechanism.
- Make risk state legible before encouraging action.
- Treat each stock as an isolated credit market.
- Use plain financial language instead of inherited DeFi vocabulary.
- Never present test or illustrative data as live production truth.

## Accessibility & Inclusion

Core workflows must remain keyboard accessible, responsive, and readable without relying on color alone for market or risk state.
