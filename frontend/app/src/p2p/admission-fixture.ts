// Public test fixture. Addresses and hashes are synthetic except the token identities.
export const registry = { schemaVersion: 2, unavailableAssets: [], markets: [{
  version: 3, chainId: 4663, chainName: "Robinhood Chain", rpcUrl: "/api/p2p-rpc",
  address: "0x3333333333333333333333333333333333333333",
  loanToken: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168", loanSymbol: "USDG", loanDecimals: 6,
  collateralToken: "0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9", collateralSymbol: "AAPL", collateralDecimals: 18,
  runtimeHash: `0x${"a".repeat(64)}`, startBlock: "1",
  vaultImplementation: "0x4444444444444444444444444444444444444444", vaultImplementationHash: `0x${"b".repeat(64)}`,
}] };
