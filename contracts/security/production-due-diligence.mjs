// Read-only production contract snapshot. No signer or write RPC is constructed.
import { createRequire } from "node:module";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const require = createRequire(new URL("../package.json", import.meta.url));
const {
  createPublicClient,
  encodeFunctionData,
  getAddress,
  http,
  keccak256,
  parseAbi,
  parseAbiItem,
  toHex,
} = require("viem");

const root = new URL("../../", import.meta.url);
const rpc = process.env.AUDIT_RPC_URL ?? "https://rpc.mainnet.chain.robinhood.com";
const owner = getAddress("0x8D9c41c35a1Cf9A6958d58880d3DC5dca36f5086");
const usdg = getAddress("0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168");
const stockRegistry = getAddress("0xe10b6f6B275de231345c20D14Ab812db62151b00");
const stockRegistryCreationBlock = 7_662n;
const publicClient = createPublicClient({ transport: http(rpc, { timeout: 30_000, retryCount: 2 }), cacheTime: 0 });

const engineAbi = parseAbi([
  "function owner() view returns(address)",
  "function riskPaused() view returns(bool)",
  "function pool() view returns(address)",
  "function usdg() view returns(address)",
  "function collateralToken() view returns(address)",
  "function primary() view returns(address)",
  "function secondary() view returns(address)",
  "function stockGuard() view returns(address)",
  "function executionGate() view returns(address)",
  "function usdgPrimary() view returns(address)",
  "function usdgSecondary() view returns(address)",
  "function staleness() view returns(uint256)",
  "function maxLtvBps() view returns(uint16)",
  "function liquidationLtvBps() view returns(uint16)",
  "function bonusBps() view returns(uint16)",
  "function deviationBps() view returns(uint16)",
  "function minimumDebt() view returns(uint256)",
  "function usdgPrimaryMaxAge() view returns(uint32)",
  "function usdgSecondaryMaxAge() view returns(uint32)",
  "function usdgMaxDeviationBps() view returns(uint16)",
  "function usdgMaxTimestampSkew() view returns(uint32)",
  "function activeDebtPositions() view returns(uint256)",
  "function activeBorrowerAt(uint256) view returns(address)",
  "function capitalOperationsAllowed() view returns(bool)",
]);
const poolAbi = parseAbi([
  "function asset() view returns(address)",
  "function creditEngine() view returns(address)",
  "function collateralToken() view returns(address)",
  "function feeRecipient() view returns(address)",
  "function debtLimit() view returns(uint256)",
  "function revenueFeeBps() view returns(uint16)",
  "function borrowAprBps() view returns(uint16)",
  "function outstandingPrincipal() view returns(uint256)",
  "function interestReceivable() view returns(uint256)",
  "function protocolFees() view returns(uint256)",
  "function cumulativeLoss() view returns(uint256)",
  "function availableCash() view returns(uint256)",
  "function totalAssets() view returns(uint256)",
  "function totalSupply() view returns(uint256)",
  "function balanceOf(address) view returns(uint256)",
  "function maxWithdraw(address) view returns(uint256)",
  "function capitalOperationsAllowed() view returns(bool)",
]);
const guardAbi = parseAbi([
  "function collateral() view returns(address)",
  "function primaryOracle() view returns(address)",
  "function guardian() view returns(address)",
  "function MAX_PRICE_AGE() view returns(uint256)",
  "function epoch() view returns(uint64)",
  "function recoveryAt() view returns(uint256)",
  "function liquidationQuarantined() view returns(bool)",
]);
const gateAbi = parseAbi([
  "function guardian() view returns(address)",
  "function epoch() view returns(uint64)",
  "function recoveryAt() view returns(uint256)",
  "function liveness() view returns(uint64 observedAt,uint64 healthySince,uint64 validUntil,uint64 epoch)",
]);
const exitAbi = parseAbi([
  "function engine() view returns(address)",
  "function usdg() view returns(address)",
  "function collateral() view returns(address)",
  "function salePool() view returns(address)",
  "function factory() view returns(address)",
  "function executionGate() view returns(address)",
  "function routeHealthy() view returns(bool)",
]);
const feedAbi = parseAbi([
  "function aggregator() view returns(address)",
  "function latestRoundData() view returns(uint80,int256,uint256,uint256,uint80)",
]);
const erc20Abi = parseAbi(["function balanceOf(address) view returns(uint256)"]);
const beaconAbi = parseAbi(["function implementation() view returns(address)"]);
const registryAbi = parseAbi([
  "function implementation() view returns(address)",
  "function paused() view returns(bool)",
  "function hasRole(bytes32,address) view returns(bool)",
]);
const timelockAbi = parseAbi(["function getMinDelay() view returns(uint256)"]);
const legacyAbi = parseAbi([
  "function owner() view returns(address)",
  "function paused() view returns(bool)",
  "function totalDebt() view returns(uint256)",
  "function availableLiquidity() view returns(uint256)",
]);

const EIP1967_IMPLEMENTATION_SLOT =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const EIP1967_BEACON_SLOT =
  "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50";
const EIP1967_ADMIN_SLOT =
  "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";
const zeroAddress = "0x0000000000000000000000000000000000000000";
const unprivilegedCaller = getAddress("0x000000000000000000000000000000000000dEaD");
const registryRoles = [
  ["DEFAULT_ADMIN_ROLE", `0x${"0".repeat(64)}`],
  ...[
    "MINTER_ROLE",
    "BURNER_ROLE",
    "PAUSER_ROLE",
    "TOKEN_DEPLOYER_ROLE",
    "BEACON_UPGRADER_ROLE",
    "FACTORY_UPGRADER_ROLE",
    "MULTIPLIER_UPDATER_ROLE",
    "METADATA_UPDATER_ROLE",
    "BLOCKER_ROLE",
    "ADMIN_BURNER_ROLE",
    "TOKEN_PAUSER_ROLE",
    "ORACLE_PAUSER_ROLE",
  ].map((name) => [name, keccak256(toHex(name))]),
];
const same = (a, b) => a?.toLowerCase() === b?.toLowerCase();
const addressFromSlot = (value) => {
  if (!value || /^0x0+$/.test(value)) return null;
  return getAddress(`0x${value.slice(-40)}`);
};

function loadJson(relative) {
  return JSON.parse(readFileSync(new URL(relative, root), "utf8"));
}

const canary = loadJson("docs/security/evidence/2026-09-03/stock-canary-commissioning.json");
const expansionPlan = loadJson("docs/security/evidence/2026-09-03/market-expansion-deployment-plan.json");
const expansionState = loadJson("docs/security/evidence/2026-09-03/market-expansion-live-progress.json");
const stateBySymbol = new Map(expansionState.markets.map((market) => [market.symbol, market]));

const markets = [
  {
    symbol: "AAPL",
    addresses: {
      engine: canary.addresses.engine,
      pool: canary.addresses.pool,
      guard: canary.frontendCandidate.secondary,
      gate: canary.frontendCandidate.stock.executionGate,
      exit: canary.directExit.executor,
      bundle: canary.addresses.bundle,
    },
    expected: {
      owner: canary.riskMonitorCandidate.owner,
      guardian: canary.riskMonitorCandidate.guardian,
      keeper: canary.riskMonitorCandidate.keeper,
      collateral: canary.frontendCandidate.collateral,
      primary: canary.frontendCandidate.primary,
      debtLimit: 50_000_000n,
      hashes: {
        engine: canary.hashes.engine,
        pool: canary.hashes.pool,
        guard: canary.hashes.stockGuard,
        gate: canary.hashes.executionGate,
        exit: canary.directExit.executorCodeHash,
        bundle: canary.hashes.bundle,
      },
    },
  },
  ...expansionPlan.markets.map((market) => {
    const deployed = stateBySymbol.get(market.symbol);
    if (!deployed) throw new Error(`Missing deployment state for ${market.symbol}`);
    return {
      symbol: market.symbol,
      addresses: market.addresses,
      expected: {
        owner,
        guardian: market.roles.guardian,
        keeper: market.roles.keeper,
        collateral: market.input.credit.collateral,
        primary: market.input.credit.primary,
        debtLimit: BigInt(market.input.debtLimit),
        hashes: {
          guard: market.runtimeHashes[0],
          gate: market.runtimeHashes[1],
          bundle: market.runtimeHashes[2],
          exit: market.runtimeHashes[3],
        },
      },
    };
  }),
];

const artifactPaths = {
  engine: "contracts/out/DockyardStockCreditEngine.sol/DockyardStockCreditEngine.json",
  pool: "contracts/out/DockyardStockCapitalPool.sol/DockyardStockCapitalPool.json",
};
function artifactRuntime(relative) {
  const artifact = loadJson(relative);
  return {
    object: artifact.deployedBytecode.object,
    immutableReferences: artifact.deployedBytecode.immutableReferences,
  };
}
function maskImmutables(bytecode, references) {
  const bytes = Buffer.from(bytecode.replace(/^0x/, ""), "hex");
  for (const locations of Object.values(references)) {
    for (const { start, length } of locations) bytes.fill(0, start, start + length);
  }
  return bytes;
}
function matchesArtifact(code, relative) {
  const artifact = artifactRuntime(relative);
  const actual = maskImmutables(code, artifact.immutableReferences);
  const compiled = maskImmutables(artifact.object, artifact.immutableReferences);
  return actual.length === compiled.length && actual.equals(compiled);
}

async function read(address, abi, functionName, args = [], blockNumber) {
  return publicClient.readContract({ address: getAddress(address), abi, functionName, args, blockNumber });
}
async function codeInfo(address, blockNumber) {
  const code = await publicClient.getCode({ address: getAddress(address), blockNumber });
  return { hash: keccak256(code), bytes: (code.length - 2) / 2, code };
}
async function proxyInfo(address, blockNumber) {
  const [implementationRaw, beaconRaw, adminRaw] = await Promise.all([
    publicClient.getStorageAt({ address: getAddress(address), slot: EIP1967_IMPLEMENTATION_SLOT, blockNumber }),
    publicClient.getStorageAt({ address: getAddress(address), slot: EIP1967_BEACON_SLOT, blockNumber }),
    publicClient.getStorageAt({ address: getAddress(address), slot: EIP1967_ADMIN_SLOT, blockNumber }),
  ]);
  const implementation = addressFromSlot(implementationRaw);
  const beacon = addressFromSlot(beaconRaw);
  const admin = addressFromSlot(adminRaw);
  const beaconImplementation = beacon
    ? await read(beacon, beaconAbi, "implementation", [], blockNumber).catch(() => null)
    : null;
  const runtime = await codeInfo(address, blockNumber);
  return {
    runtimeHash: runtime.hash,
    implementation,
    beacon,
    admin,
    beaconImplementation,
    implementationRuntimeHash: implementation
      ? (await codeInfo(implementation, blockNumber)).hash
      : beaconImplementation
        ? (await codeInfo(beaconImplementation, blockNumber)).hash
        : null,
  };
}

async function rejectedCall(address, abi, functionName, args, blockNumber) {
  try {
    await publicClient.call({
      account: unprivilegedCaller,
      to: getAddress(address),
      data: encodeFunctionData({ abi, functionName, args }),
      blockNumber,
    });
    return false;
  } catch {
    return true;
  }
}

async function acceptedCall(account, address, abi, functionName, args, blockNumber) {
  try {
    await publicClient.call({
      account: getAddress(account),
      to: getAddress(address),
      data: encodeFunctionData({ abi, functionName, args }),
      blockNumber,
    });
    return true;
  } catch {
    return false;
  }
}

async function inspectMarket(market, blockNumber) {
  const { addresses, expected } = market;
  const [engineCode, poolCode, guardCode, gateCode, exitCode, bundleCode] = await Promise.all([
    codeInfo(addresses.engine, blockNumber),
    codeInfo(addresses.pool, blockNumber),
    codeInfo(addresses.guard, blockNumber),
    codeInfo(addresses.gate, blockNumber),
    codeInfo(addresses.exit, blockNumber),
    codeInfo(addresses.bundle, blockNumber),
  ]);
  const engineNames = [
    "owner", "riskPaused", "pool", "usdg", "collateralToken", "primary", "secondary", "stockGuard",
    "executionGate", "usdgPrimary", "usdgSecondary", "staleness", "maxLtvBps", "liquidationLtvBps",
    "bonusBps", "deviationBps", "minimumDebt", "usdgPrimaryMaxAge", "usdgSecondaryMaxAge",
    "usdgMaxDeviationBps", "usdgMaxTimestampSkew", "activeDebtPositions", "capitalOperationsAllowed",
  ];
  const poolNames = [
    "asset", "creditEngine", "collateralToken", "feeRecipient", "debtLimit", "revenueFeeBps", "borrowAprBps",
    "outstandingPrincipal", "interestReceivable", "protocolFees", "cumulativeLoss", "availableCash", "totalAssets",
    "totalSupply", "capitalOperationsAllowed",
  ];
  const guardNames = [
    "collateral", "primaryOracle", "guardian", "MAX_PRICE_AGE", "epoch", "recoveryAt", "liquidationQuarantined",
  ];
  const gateNames = ["guardian", "epoch", "recoveryAt", "liveness"];
  const engineValues = await Promise.all(engineNames.map((name) => read(addresses.engine, engineAbi, name, [], blockNumber)));
  const poolValues = await Promise.all(poolNames.map((name) => read(addresses.pool, poolAbi, name, [], blockNumber)));
  const guardValues = await Promise.all(guardNames.map((name) => read(addresses.guard, guardAbi, name, [], blockNumber)));
  const gateValues = await Promise.all(gateNames.map((name) => read(addresses.gate, gateAbi, name, [], blockNumber)));
  const engine = Object.fromEntries(engineNames.map((name, index) => [name, engineValues[index]]));
  const pool = Object.fromEntries(poolNames.map((name, index) => [name, poolValues[index]]));
  const guard = Object.fromEntries(guardNames.map((name, index) => [name, guardValues[index]]));
  const gate = Object.fromEntries(gateNames.map((name, index) => [name, gateValues[index]]));
  const [ownerShares, ownerMaxWithdraw, poolTokenBalance, engineTokenBalance, exitTokenBalance, exitRouteHealthy,
    collateralProxy, primaryAggregator] = await Promise.all([
    read(addresses.pool, poolAbi, "balanceOf", [owner], blockNumber),
    read(addresses.pool, poolAbi, "maxWithdraw", [owner], blockNumber),
    read(usdg, erc20Abi, "balanceOf", [addresses.pool], blockNumber),
    read(usdg, erc20Abi, "balanceOf", [addresses.engine], blockNumber),
    read(usdg, erc20Abi, "balanceOf", [addresses.exit], blockNumber),
    read(addresses.exit, exitAbi, "routeHealthy", [], blockNumber),
    proxyInfo(expected.collateral, blockNumber),
    read(expected.primary, feedAbi, "aggregator", [], blockNumber).catch(() => null),
  ]);
  const activeBorrowers = [];
  for (let i = 0n; i < engine.activeDebtPositions; i += 1n) {
    activeBorrowers.push(await read(addresses.engine, engineAbi, "activeBorrowerAt", [i], blockNumber));
  }
  const wiringChecks = {
    engineOwner: same(engine.owner, expected.owner),
    enginePool: same(engine.pool, addresses.pool),
    engineUsdg: same(engine.usdg, usdg),
    engineCollateral: same(engine.collateralToken, expected.collateral),
    enginePrimary: same(engine.primary, expected.primary),
    engineGuard: same(engine.secondary, addresses.guard) && same(engine.stockGuard, addresses.guard),
    engineGate: same(engine.executionGate, addresses.gate),
    poolEngine: same(pool.creditEngine, addresses.engine),
    poolAsset: same(pool.asset, usdg),
    poolCollateral: same(pool.collateralToken, expected.collateral),
    poolTreasury: same(pool.feeRecipient, owner),
    poolDebtLimit: pool.debtLimit === expected.debtLimit,
    guardCollateral: same(guard.collateral, expected.collateral),
    guardPrimary: same(guard.primaryOracle, expected.primary),
    guardGuardian: same(guard.guardian, expected.guardian),
    gateGuardian: same(gate.guardian, expected.guardian),
  };
  const runtimeChecks = {
    engineMatchesProductionArtifactIgnoringImmutables: matchesArtifact(engineCode.code, artifactPaths.engine),
    poolMatchesProductionArtifactIgnoringImmutables: matchesArtifact(poolCode.code, artifactPaths.pool),
    engineExactHash: expected.hashes.engine ? engineCode.hash === expected.hashes.engine : null,
    poolExactHash: expected.hashes.pool ? poolCode.hash === expected.hashes.pool : null,
    guardExactHash: guardCode.hash === expected.hashes.guard,
    gateExactHash: gateCode.hash === expected.hashes.gate,
    exitExactHash: exitCode.hash === expected.hashes.exit,
    bundleExactHash: bundleCode.hash === expected.hashes.bundle,
  };
  return {
    symbol: market.symbol,
    addresses,
    roles: { owner: expected.owner, guardian: expected.guardian, keeper: expected.keeper },
    engine,
    pool: { ...pool, ownerShares, ownerMaxWithdraw, tokenBalance: poolTokenBalance },
    guard,
    gate,
    activeBorrowers,
    residualBalances: { engineUsdg: engineTokenBalance, exitUsdg: exitTokenBalance },
    exitRouteHealthy,
    externalDependencies: {
      collateral: { address: expected.collateral, ...collateralProxy },
      stockFeed: {
        address: expected.primary,
        aggregator: primaryAggregator,
        aggregatorRuntimeHash: primaryAggregator ? (await codeInfo(primaryAggregator, blockNumber)).hash : null,
      },
    },
    wiringChecks,
    runtime: {
      engine: { hash: engineCode.hash, bytes: engineCode.bytes },
      pool: { hash: poolCode.hash, bytes: poolCode.bytes },
      guard: { hash: guardCode.hash, bytes: guardCode.bytes },
      gate: { hash: gateCode.hash, bytes: gateCode.bytes },
      exit: { hash: exitCode.hash, bytes: exitCode.bytes },
      bundle: { hash: bundleCode.hash, bytes: bundleCode.bytes },
    },
    runtimeChecks,
  };
}

async function inspectLegacy(address, blockNumber) {
  const runtime = await codeInfo(address, blockNumber);
  const names = ["owner", "paused", "totalDebt", "availableLiquidity"];
  const values = await Promise.all(names.map((name) => read(address, legacyAbi, name, [], blockNumber)));
  return { address, runtimeHash: runtime.hash, ...Object.fromEntries(names.map((name, index) => [name, values[index]])) };
}

async function inspectStockRegistry(blockNumber) {
  const roleGranted = parseAbiItem(
    "event RoleGranted(bytes32 indexed role,address indexed account,address indexed sender)",
  );
  const roleRevoked = parseAbiItem(
    "event RoleRevoked(bytes32 indexed role,address indexed account,address indexed sender)",
  );
  const [grants, revocations, implementation, paused, runtime] = await Promise.all([
    publicClient.getLogs({
      address: stockRegistry,
      event: roleGranted,
      fromBlock: stockRegistryCreationBlock,
      toBlock: blockNumber,
    }),
    publicClient.getLogs({
      address: stockRegistry,
      event: roleRevoked,
      fromBlock: stockRegistryCreationBlock,
      toBlock: blockNumber,
    }),
    read(stockRegistry, registryAbi, "implementation", [], blockNumber),
    read(stockRegistry, registryAbi, "paused", [], blockNumber),
    codeInfo(stockRegistry, blockNumber),
  ]);
  const candidatesByRole = new Map(registryRoles.map(([, hash]) => [hash.toLowerCase(), new Set()]));
  for (const log of [...grants, ...revocations]) {
    const role = log.args.role.toLowerCase();
    if (candidatesByRole.has(role)) candidatesByRole.get(role).add(getAddress(log.args.account));
  }
  const roles = [];
  for (const [name, hash] of registryRoles) {
    const holders = [];
    for (const account of candidatesByRole.get(hash.toLowerCase())) {
      if (await read(stockRegistry, registryAbi, "hasRole", [hash, account], blockNumber)) {
        const code = await publicClient.getCode({ address: account, blockNumber });
        holders.push({
          account,
          isContract: code !== undefined && code !== zeroAddress,
          codeBytes: code ? (code.length - 2) / 2 : 0,
        });
      }
    }
    roles.push({ name, hash, holders });
  }
  return {
    address: stockRegistry,
    runtimeHash: runtime.hash,
    implementation,
    implementationRuntimeHash: (await codeInfo(implementation, blockNumber)).hash,
    paused,
    roleHistory: { grants: grants.length, revocations: revocations.length },
    roles,
  };
}

try {
  if ((await publicClient.getChainId()) !== 4663) throw new Error("Wrong chain");
  const head = await publicClient.getBlock();
  const ownerCode = await publicClient.getCode({ address: owner, blockNumber: head.number });
  const [marketSnapshots, usdgProxy, usdgOwner, usdgPrimaryAggregator, legacy, registry] = await Promise.all([
    Promise.all(markets.map((market) => inspectMarket(market, head.number))),
    proxyInfo(usdg, head.number),
    read(usdg, parseAbi(["function owner() view returns(address)"]), "owner", [], head.number).catch(() => null),
    read(canary.frontendCandidate.stock.usdgPrimary, feedAbi, "aggregator", [], head.number).catch(() => null),
    Promise.all([
      "0x576c510e9A268B06448f67598B7BF1ed33388e20",
      "0x24043E8EFaB262f5198B87b5AA5A46Bc72AADDD8",
      "0x9545CA977C235BE45eD97C5fD76b5309376a8eB9",
      "0xb99D842DFFc140b9DD1927767653Bf21861120e9",
    ].map((address) => inspectLegacy(address, head.number))),
    inspectStockRegistry(head.number),
  ]);
  const usdgOwnerCode = usdgOwner
    ? await publicClient.getCode({ address: usdgOwner, blockNumber: head.number })
    : undefined;
  const usdgOwnerTimelock = usdgOwner
    ? await read(usdgOwner, timelockAbi, "getMinDelay", [], head.number).catch(() => null)
    : null;
  const currentBlock = await publicClient.getBlock({ blockNumber: head.number });
  if (currentBlock.hash !== head.hash) throw new Error("Snapshot block changed during capture");
  const aapl = marketSnapshots[0];
  const unauthorizedCallProbes = {
    caller: unprivilegedCaller,
    ownerPauseRejected: await rejectedCall(
      aapl.addresses.engine,
      parseAbi(["function setRiskPaused(bool)"]),
      "setRiskPaused",
      [true],
      head.number,
    ),
    ownershipTransferRejected: await rejectedCall(
      aapl.addresses.engine,
      parseAbi(["function transferOwnership(address)"]),
      "transferOwnership",
      [unprivilegedCaller],
      head.number,
    ),
    engineOnlyDrawRejected: await rejectedCall(
      aapl.addresses.pool,
      parseAbi(["function draw(address,uint256)"]),
      "draw",
      [unprivilegedCaller, 1n],
      head.number,
    ),
    ownerShareWithdrawalRejected: await rejectedCall(
      aapl.addresses.pool,
      parseAbi(["function withdraw(uint256,address,address) returns(uint256)"]),
      "withdraw",
      [1n, unprivilegedCaller, owner],
      head.number,
    ),
    forgedSwapCallbackRejected: await rejectedCall(
      aapl.addresses.exit,
      parseAbi(["function uniswapV3SwapCallback(int256,int256,bytes)"]),
      "uniswapV3SwapCallback",
      [1n, -1n, "0x"],
      head.number,
    ),
    legacyOwnerWithdrawalRejected: await rejectedCall(
      legacy[0].address,
      parseAbi(["function withdrawLiquidity(address,uint256)"]),
      "withdrawLiquidity",
      [unprivilegedCaller, 1n],
      head.number,
    ),
    stockBeaconUpgradeRejected: await rejectedCall(
      stockRegistry,
      parseAbi(["function upgradeTo(address)"]),
      "upgradeTo",
      [registry.implementation],
      head.number,
    ),
    stockRoleGrantRejected: await rejectedCall(
      stockRegistry,
      parseAbi(["function grantRole(bytes32,address)"]),
      "grantRole",
      [registryRoles.find(([name]) => name === "BEACON_UPGRADER_ROLE")[1], unprivilegedCaller],
      head.number,
    ),
    stockAccountBlockRejected: await rejectedCall(
      stockRegistry,
      parseAbi(["function blockAccounts(address[])"]),
      "blockAccounts",
      [[owner]],
      head.number,
    ),
    stockMintRejected: await rejectedCall(
      aapl.externalDependencies.collateral.address,
      parseAbi(["function mint(address,uint256)"]),
      "mint",
      [unprivilegedCaller, 1n],
      head.number,
    ),
    stockAdminBurnRejected: await rejectedCall(
      aapl.externalDependencies.collateral.address,
      parseAbi(["function adminBurn(address,uint256)"]),
      "adminBurn",
      [owner, 0n],
      head.number,
    ),
    usdgUpgradeRejected: await rejectedCall(
      usdg,
      parseAbi(["function upgradeTo(address)"]),
      "upgradeTo",
      [usdgProxy.implementation],
      head.number,
    ),
    usdgSupplyIncreaseRejected: await rejectedCall(
      usdg,
      parseAbi(["function increaseSupplyToAddress(uint256,address)"]),
      "increaseSupplyToAddress",
      [1n, unprivilegedCaller],
      head.number,
    ),
  };
  const [pauseAcceptedByMarket, fullRedemptionAcceptedByMarket] = await Promise.all([
    Promise.all(marketSnapshots.map(async (market) => ({
      symbol: market.symbol,
      accepted: await acceptedCall(
        owner,
        market.addresses.engine,
        parseAbi(["function setRiskPaused(bool)"]),
        "setRiskPaused",
        [true],
        head.number,
      ),
    }))),
    Promise.all(marketSnapshots.map(async (market) => ({
      symbol: market.symbol,
      shares: market.pool.ownerShares,
      accepted: await acceptedCall(
        owner,
        market.addresses.pool,
        parseAbi(["function redeem(uint256,address,address) returns(uint256)"]),
        "redeem",
        [market.pool.ownerShares, owner, owner],
        head.number,
      ),
    }))),
  ]);
  const authorizedOperationProbes = {
    caller: owner,
    pauseAcceptedByMarket,
    ownershipTransferAccepted: await acceptedCall(
      owner,
      aapl.addresses.engine,
      parseAbi(["function transferOwnership(address)"]),
      "transferOwnership",
      [unprivilegedCaller],
      head.number,
    ),
    fullRedemptionAcceptedByMarket,
    legacyLiquidityWithdrawalAccepted: await acceptedCall(
      owner,
      legacy[0].address,
      parseAbi(["function withdrawLiquidity(address,uint256)"]),
      "withdrawLiquidity",
      [owner, legacy[0].availableLiquidity],
      head.number,
    ),
  };
  const summary = {
    marketCount: marketSnapshots.length,
    unpausedMarkets: marketSnapshots.filter((market) => !market.engine.riskPaused).length,
    activeDebtPositions: marketSnapshots.reduce((sum, market) => sum + market.engine.activeDebtPositions, 0n),
    outstandingPrincipal: marketSnapshots.reduce((sum, market) => sum + market.pool.outstandingPrincipal, 0n),
    poolCash: marketSnapshots.reduce((sum, market) => sum + market.pool.availableCash, 0n),
    ownerMaxWithdraw: marketSnapshots.reduce((sum, market) => sum + market.pool.ownerMaxWithdraw, 0n),
    cumulativeLoss: marketSnapshots.reduce((sum, market) => sum + market.pool.cumulativeLoss, 0n),
    allWiringChecksPass: marketSnapshots.every((market) => Object.values(market.wiringChecks).every(Boolean)),
    allRequiredRuntimeChecksPass: marketSnapshots.every((market) =>
      Object.values(market.runtimeChecks).every((value) => value === null || value === true)),
    allExitRoutesHealthy: marketSnapshots.every((market) => market.exitRouteHealthy),
    allLegacyPausedAndDebtFree: legacy.every((vault) => vault.paused && vault.totalDebt === 0n),
  };
  const evidence = {
    capturedAt: new Date().toISOString(),
    chainId: 4663,
    blockNumber: head.number,
    blockHash: head.hash,
    blockTimestamp: head.timestamp,
    owner: { address: owner, isContract: ownerCode !== zeroAddress && ownerCode !== undefined },
    summary,
    unauthorizedCallProbes,
    authorizedOperationProbes,
    markets: marketSnapshots,
    externalUpgradeSurfaces: {
      usdg: {
        address: usdg,
        owner: usdgOwner,
        ownerIsContract: usdgOwnerCode !== undefined && usdgOwnerCode !== zeroAddress,
        ownerTimelockSeconds: usdgOwnerTimelock,
        ...usdgProxy,
      },
      stockRegistry: registry,
      usdgPrimary: { address: canary.frontendCandidate.stock.usdgPrimary, aggregator: usdgPrimaryAggregator },
      markets: marketSnapshots.map((market) => ({ symbol: market.symbol, ...market.externalDependencies })),
    },
    legacy,
  };
  const directory = new URL("docs/security/evidence/2026-09-04/", root);
  mkdirSync(directory, { recursive: true });
  const output = new URL("production-contract-snapshot.json", directory);
  writeFileSync(output, `${JSON.stringify(evidence, (_, value) => typeof value === "bigint" ? value.toString() : value, 2)}\n`);
  console.log(JSON.stringify({
    output: fileURLToPath(output),
    blockNumber: String(head.number),
    blockTimestamp: String(head.timestamp),
    summary: JSON.parse(JSON.stringify(summary, (_, value) => typeof value === "bigint" ? value.toString() : value)),
  }));
} catch (error) {
  console.error(`Read-only production snapshot failed: ${error.name}: ${error.message}`);
  process.exitCode = 1;
}
