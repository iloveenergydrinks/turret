# Turret

**Borrow against memecoins, stocks and NFTs.**

Turret lets borrowers obtain USDG against supported collateral on Robinhood Chain. Lenders can provide pool liquidity or agree fixed terms directly with borrowers.

[Website](https://turret.capital) · [Documentation](https://docs.turret.capital) · [Blog](https://blog.turret.capital) · [X](https://x.com/turret_capital)

## What's here

- **Pool lending:** isolated USDG pools, collateralized borrowing, interest accounting and liquidations.
- **P2P lending:** offers and requests for stocks, memecoins and NFTs, with explicit repayment terms.
- **Frontend:** Borrow, Earn, Portfolio, staking, wallet confirmations and transaction recovery.
- **Services:** price and risk checks, liquidators, loan indexing, notifications, rewards and dev-funded buybacks with atomic token burns.

Turret is in open beta. Supported markets, liquidity and live parameters can change. A contract or market configuration in this repository is not, by itself, evidence that a market is active or audited.

## Repository map

| Directory | Contents |
| --- | --- |
| `frontend/app` | Next.js application, frontend tests and API/server modules |
| `frontend/uikit` | Shared React components |
| `contracts/src/research` | Isolated pool, credit, oracle and liquidation contracts |
| `contracts/p2p` | Token and NFT peer-to-peer lending contracts |
| `contracts/rewards` | Staking, lender rewards, borrower cashback and buyback contracts |
| `contracts/variable-rate` | Utilization-based interest-rate contracts |
| `services` | Independently operated backend workers and APIs |
| `shared` | Shared application and service modules |
| `docs/gitbook` | Public product and protocol documentation |
| `docs/legacy` | Reference material for the inherited core subsystem |

## Local development

Use Node.js 22 and pnpm 8.15.8. Contract development also requires Foundry; initialize the pinned submodules before compiling Solidity.

```sh
git clone --recurse-submodules https://github.com/iloveenergydrinks/turret.git
cd turret
corepack enable
corepack prepare pnpm@8.15.8 --activate
pnpm install --frozen-lockfile
cp frontend/app/.env.example frontend/app/.env
pnpm --dir frontend/app build-uikit
pnpm --dir frontend/app build-banner
pnpm --dir frontend/app build-panda
pnpm dev
```

The environment template targets Robinhood Chain with no enabled isolated pools and a nonfunctional WalletConnect placeholder. Configure your own wallet integration and RPC endpoints where needed. Browser variables beginning with `NEXT_PUBLIC_` are public; never put signing keys, API secrets or server credentials in them.

The server and independent services have separate configuration. Consult each service's README, package scripts and `.env.example`; workers should start in observation mode. Do not use a production wallet for local tests.

## Checks

```sh
pnpm --dir frontend/app test:unit
pnpm --dir frontend/app test:server
forge test --root contracts/p2p
forge test --root contracts/rewards
```

See [release validation and known test failures](docs/PUBLIC_RELEASE.md). Some integration tests require a local Anvil node or explicitly configured RPC access. Production deployment logs, private service state, signing pages and temporary release archives are intentionally excluded.

## Releases and deployment

This repository contains application and protocol source. Production has historically used separately assembled frontend exports and independently deployed service versions. A checkout is not a byte-for-byte reconstruction of every live deployment. Verify contract addresses, bytecode, environment configuration and the intended source revision before operating a service or deploying a release.

`Dockerfile.railway` is the application build definition. Publishing code here does not authorize moving funds or deploying contracts. See [contributing](CONTRIBUTING.md) for the development workflow and [security](SECURITY.md) for private reporting.

## Licensing and attribution

**This is a mixed-license repository.** The frontend is MIT-licensed. Turret's independently authored services and contracts are available under the licenses identified in their directories and SPDX headers. Some inherited core contracts retain BUSL-1.1; those files are source-available and are not currently open source. Their stated change date is September 1, 2027.

Read [LICENSING.md](LICENSING.md), the applicable directory licenses, and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Required upstream notices remain. The Turret name, logos and third-party asset logos are not granted for use as trademarks by the software licenses.
