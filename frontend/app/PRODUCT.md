# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

People who already hold tokenized US equities and want dollar liquidity without selling their market exposure. They understand collateral, loan-to-value ratios, and liquidation risk, but should not need prior Liquity knowledge.

## Product Purpose

Dockyard lets users deposit supported Stock Tokens and borrow existing USDG liquidity against them. Success means a user can understand the risk, choose a stock, open or manage a position, and repay without confusing the tokenized exposure for ownership of the underlying share.

## Positioning

The product is an owner-funded credit facility for Stock Tokens: “Borrow against Wall Street.” Unlike a protocol-issued stablecoin, Dockyard lends canonical USDG already supplied to its vault. Each supported Stock Token has an isolated debt ceiling and risk profile, while all markets draw from the same USDG liquidity balance.

## Operating Context

Users connect an EVM wallet on Robinhood Chain, choose one supported Stock Token per position, deposit collateral, borrow supplied USDG, monitor LTV and oracle state, manage debt, and repay in USDG. The initial set is AAPL, MSFT, GOOGL, AMZN, META, NVDA, AMD, ORCL, MU, and TSLA.

## Capabilities and Constraints

- Fund or withdraw available USDG as the vault owner; deposit collateral, borrow, repay, withdraw collateral, and liquidate unsafe positions.
- Portfolio or multi-collateral vaults are not part of this implementation.
- A protocol-issued stablecoin, redemptions, Stability Pools, leverage, governance staking, and inherited Liquity yield wrappers are not part of this implementation.
- Market closure, stale prices, corporate-action pauses, and liquidation risk must be explicit states.
- The UI must identify the borrowed asset as canonical USDG and must never imply that Dockyard can mint USDG.
- The product is independent and must not imply Robinhood endorsement or ownership of underlying shares.
- Production deployment remains gated by licensing, oracle simulations, independent audits, parameter review, and deployment verification.

## Brand Commitments

The protocol name is Dockyard. USDG is the existing asset lent by the vault; Dockyard does not issue or mint it. The core message is “Borrow against Wall Street.” The identity should be minimal, narrow, friendly, and direct, with an understated maritime influence rather than literal nautical decoration. A subtle animated wave shader may give the page ambient motion, but it must remain secondary to the borrowing task and respect reduced-motion preferences. The interface should inherit the approachable simplicity of Liquity V1 without copying its logo or becoming a corporate trading terminal. A new original Dockyard logo and complete frontend visual world are required.

## Evidence on Hand

The repository contains a standalone owner-funded USDG credit vault, ten-market Stock Token manifest, risk parameters, Robinhood token addresses, dual Chainlink feed configuration, tests, and deployment tooling. There are no approved customer claims, usage metrics, audit claims, or final production deployment addresses.

## Product Principles

- Lead with the collateral-to-liquidity mechanism.
- Make risk state legible before encouraging action.
- Treat each stock as an isolated credit market.
- Use plain financial language instead of inherited DeFi vocabulary.
- Never present test or illustrative data as live production truth.

## Accessibility & Inclusion

Core workflows must remain keyboard accessible, responsive, and readable without relying on color alone for market or risk state.
