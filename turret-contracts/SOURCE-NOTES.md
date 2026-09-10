# Turret lending source reference — September 10, 2026

This source bundle supports review of Turret's DefiLlama lending adapter. It contains the current centralized credit engine and capital pool, token P2P lending versions 1–3, NFT lending, and their Solidity dependencies. It is not an audit or a complete deployment/recovery toolkit.

The 32 Solidity files were copied without content changes from the compiler-artifact source sets. Each file's Keccak-256 digest was checked against its original compiler metadata; `source-manifest.json` records the digests. Paths were reorganized to remove machine-specific paths and make the bundle self-contained.

`runtime-verification.json` records 66 successful comparisons against Robinhood Chain: 13 current credit engines, 13 current capital pools, 39 token P2P managers, and the NFT lending manager. Comparisons mask only compiler-declared constructor immutable offsets. All other runtime bytes, including metadata, match the original artifacts. This does not verify the values of masked constructor arguments, each per-offer clone, or every retired deployment. It is not an explorer source-verification certificate.

## Build

```sh
forge build --root turret-contracts
```

Compiler: Solidity 0.8.24; optimizer enabled, 200 runs; EVM Cancun. The self-contained bundle compiled successfully. Foundry emitted lint warnings, including timestamp comparisons; a successful build is not a security assessment. Reorganized source paths can change compiler metadata, so compare the original artifact hashes and recorded deployment checks rather than expecting this build's entire bytecode to match byte-for-byte.

## Accounting and trust

- `central/TurretCreditEngine.sol`: operator-signed pricing and borrowing approvals. The operator is trusted; incorrect or compromised prices can cause losses. `TRUST_MODEL()` returns `CENTRAL_RISK_SIGNER` on the current engines.
- `central/TurretCapitalPool.sol` and `reviewed/research/DockyardIsolatedCapitalPool.sol`: isolated lender accounting. `availableCash()` subtracts accrued protocol fees from USDG cash; `totalAssets()` also includes principal and interest, so it is not the adapter's base-TVL measure.
- `p2p/TurretP2PLending*.sol`: fixed-term ERC-20 loans. V1/V2 hold escrow in the manager. V3 uses per-offer vaults. Committed principal includes reserved open offers; subtract reserved principal to report active loans.
- `p2p/TurretNFTLending.sol`: fixed-term NFT loans without a price oracle. The adapter measures USDG escrow, not NFT floor values.

Original shared-vault code is available elsewhere in this repository under `contracts/src/DockyardUSDGCreditVault.sol`; the adapter also retains legacy recovery custody from the public portfolio inventory. That does not mean every historical deployment is covered by this source bundle's runtime checks.

Public inventories: [active credit pools](https://turret.capital/borrow-pools.json), [portfolio/recovery pools](https://turret.capital/portfolio-pools.json), [token P2P markets](https://turret.capital/p2p-markets.json), [NFT market](https://turret.capital/nft-market.json).

No independent external audit is claimed. Solidity license headers are retained; OpenZeppelin's license is included alongside its dependency sources.
