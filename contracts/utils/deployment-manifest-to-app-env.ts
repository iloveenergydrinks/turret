import { createPublicClient, http, parseAbi } from "viem";
import type { Address } from "viem";
import { z } from "zod";
import { echo, fs, minimist } from "zx";

const HELP = `
Converts a deployment manifest created by DeployLiquity2 or a Stock Token
deployer into environment variables for frontend/app.

Usage:
  ./deployment-manifest-to-app-env.ts <MANIFEST_JSON> [OUTPUT_ENV] [OPTIONS]

Arguments:
  MANIFEST_JSON                            Path to the manifest file.
  OUTPUT_ENV                               Path to the environment variables
                                           file to write. If not provided, they
                                           will be printed to stdout.

Options:
  --help, -h                               Show this help message.
  --append                                 Append to the output file instead of
                                           overwriting it (requires OUTPUT_ENV).
  --verify-rpc URL                         Verify every Stock Token deployment
                                           contract and core wiring at URL before
                                           enabling interactive frontend flows.
`;

const argv = minimist(process.argv.slice(2), {
  alias: {
    h: "help",
  },
  boolean: [
    "help",
    "append",
  ],
  string: ["verify-rpc"],
});

const ZAddress = z.string().regex(/^0x[0-9a-fA-F]{40}$/).transform((value) => value as Address);
const ZDeploymentManifest = z.object({
  collateralRegistry: ZAddress,
  boldToken: ZAddress,
  hintHelpers: ZAddress,
  multiTroveGetter: ZAddress,
  debtInFrontHelper: ZAddress,
  exchangeHelpers: ZAddress,
  exchangeHelpersV2: ZAddress,
  redemptionHelper: ZAddress,

  governance: z.object({
    LUSDToken: ZAddress,
    LQTYToken: ZAddress,
    stakingV1: ZAddress,
    governance: ZAddress,
  }),

  branches: z.array(
    z.object({
      activePool: ZAddress,
      addressesRegistry: ZAddress,
      borrowerOperations: ZAddress,
      collSurplusPool: ZAddress,
      collToken: ZAddress,
      defaultPool: ZAddress,
      gasPool: ZAddress,
      leverageZapper: ZAddress,
      metadataNFT: ZAddress,
      priceFeed: ZAddress,
      sortedTroves: ZAddress,
      stabilityPool: ZAddress,
      troveManager: ZAddress,
      troveNFT: ZAddress,
    }),
  ),
});

const ZStockDeploymentManifest = z.object({
  chainId: z.union([z.literal(31337), z.literal(4663), z.literal(46630)]),
  stablecoin: ZAddress,
  collateralRegistry: ZAddress,
  hintHelpers: ZAddress,
  multiTroveGetter: ZAddress,
  debtInFrontHelper: ZAddress,
  redemptionHelper: ZAddress,
  disabledExchange: ZAddress,
  weth: ZAddress,
  stockTokens: z.array(ZAddress).length(10),
  addressRegistries: z.array(ZAddress).length(10),
  borrowerOperations: z.array(ZAddress).length(10),
  stabilityPools: z.array(ZAddress).length(10),
  troveNFTs: z.array(ZAddress).length(10),
  activePools: z.array(ZAddress).length(10),
  defaultPools: z.array(ZAddress).length(10),
  gasPools: z.array(ZAddress).length(10),
  collSurplusPools: z.array(ZAddress).length(10),
  sortedTroves: z.array(ZAddress).length(10),
  troveManagers: z.array(ZAddress).length(10),
  zappers: z.array(ZAddress).length(10),
  priceFeeds: z.array(ZAddress).length(10),
});

type DeploymentManifest = z.infer<typeof ZDeploymentManifest>;
type StockDeploymentManifest = z.infer<typeof ZStockDeploymentManifest>;

const STOCK_SYMBOLS = [
  "AAPL",
  "MSFT",
  "GOOGL",
  "AMZN",
  "META",
  "NVDA",
  "AMD",
  "ORCL",
  "MU",
  "TSLA",
] as const;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export async function main() {
  const options = {
    help: argv["help"],
    append: argv["append"],
    verifyRpc: argv["verify-rpc"],
    inputJsonPath: argv._[0],
    outputEnvPath: argv._[1],
  };

  if (options.help) {
    echo`${HELP}`;
    process.exit(0);
  }

  if (!options.inputJsonPath) {
    console.error("\nPlease provide the path to the deployment artifacts JSON file.\n");
    process.exit(1);
  }

  const manifest = parseDeploymentManifest(
    fs.readFileSync(options.inputJsonPath, "utf-8"),
  );

  const appEnv = "stockTokens" in manifest
    ? stockDeploymentToAppEnvVariables(manifest)
    : deployedContractsToAppEnvVariables(manifest);

  if ("stockTokens" in manifest && options.verifyRpc) {
    await verifyStockDeployment(manifest, options.verifyRpc);
    appEnv.NEXT_PUBLIC_DEPLOYMENT_VERIFIED = true;
  }

  const outputEnv = objectToEnvironmentVariables(appEnv);

  if (!options.outputEnvPath) {
    console.log(outputEnv);
    process.exit(0);
  }

  fs.ensureFileSync(options.outputEnvPath);
  if (options.append) {
    fs.appendFileSync(options.outputEnvPath, `\n${outputEnv}\n`);
  } else {
    fs.writeFileSync(options.outputEnvPath, `${outputEnv}\n`);
  }

  console.log(`\nEnvironment variables written to ${options.outputEnvPath}.\n`);
}

export function objectToEnvironmentVariables(object: Record<string, unknown>) {
  return Object.entries(object)
    .map(([key, value]) => `${key}=${value}`)
    .sort()
    .sort((a, b) => {
      if (a.includes("_COLL_") && !b.includes("_COLL_")) {
        return -1;
      }
      if (!a.includes("_COLL_") && b.includes("_COLL_")) {
        return 1;
      }
      return 0;
    })
    .join("\n");
}

function deployedContractsToAppEnvVariables(manifest: DeploymentManifest) {
  if (manifest.branches.length === 0) {
    console.error("\nNo collateral contracts found in the deployment manifest.\n");
    process.exit(1);
  }

  const appEnvVariables: Record<string, string> = {
    // WETH is always the first collateral token
    NEXT_PUBLIC_CONTRACT_WETH: manifest.branches[0].collToken,
  };

  const { branches, governance, ...protocol } = manifest;

  // protocol contracts
  for (const [contractName, address] of Object.entries(protocol)) {
    const envVarName = contractNameToAppEnvVariable(contractName, "CONTRACT");
    if (envVarName) {
      appEnvVariables[envVarName] = address;
    }
  }

  // branches contracts
  for (const [index, contract] of Object.entries(branches)) {
    for (const [contractName, address] of Object.entries(contract)) {
      const envVarName = contractNameToAppEnvVariable(contractName, `COLL_${index}_CONTRACT`);
      if (envVarName) {
        appEnvVariables[envVarName] = address;
      }
    }
  }

  // governance contracts
  for (const [contractName, address] of Object.entries(governance)) {
    const envVarName = contractNameToAppEnvVariable(
      contractName,
      contractName.endsWith("Initiative") ? "INITIATIVE" : "CONTRACT",
    );
    if (envVarName) {
      appEnvVariables[envVarName] = address;
    }
  }

  return appEnvVariables;
}

export function stockDeploymentToAppEnvVariables(manifest: StockDeploymentManifest) {
  const isRobinhoodMainnet = manifest.chainId === 4663;
  const isLocal = manifest.chainId === 31337;
  const appEnvVariables: Record<string, string | boolean> = {
    NEXT_PUBLIC_ACCOUNT_SCREEN: true,
    NEXT_PUBLIC_AIRDROP_VAULTS: false,
    NEXT_PUBLIC_AIRDROP_VAULTS_URL: "",
    NEXT_PUBLIC_CHAIN_CURRENCY: "Ether|ETH|18",
    NEXT_PUBLIC_CHAIN_ID: String(manifest.chainId),
    NEXT_PUBLIC_CHAIN_NAME: isLocal ? "Anvil" : isRobinhoodMainnet ? "Robinhood Chain" : "Robinhood Chain Testnet",
    NEXT_PUBLIC_CHAIN_RPC_URL: isLocal
      ? "http://127.0.0.1:8545"
      : isRobinhoodMainnet
      ? "https://rpc.mainnet.chain.robinhood.com"
      : "https://rpc.testnet.chain.robinhood.com",
    NEXT_PUBLIC_DEPLOYMENT_FLAVOR: isLocal
      ? "Local Stock Token Sandcastle"
      : isRobinhoodMainnet
      ? "rUSD Robinhood Mainnet"
      : "Stock Token Sandcastle",
    NEXT_PUBLIC_ENABLE_LEVERAGE: false,
    NEXT_PUBLIC_ENABLE_STAKING: false,
    NEXT_PUBLIC_LEGACY_CHECK: false,
    NEXT_PUBLIC_KNOWN_DELEGATES_URL: "",
    NEXT_PUBLIC_KNOWN_INITIATIVES_URL: "",
    NEXT_PUBLIC_LIQUITY_GOVERNANCE_URL: "",
    NEXT_PUBLIC_LIQUITY_STATS_URL: "",
    NEXT_PUBLIC_SAFE_API_URL: "",
    NEXT_PUBLIC_SAFETY_MODE_CHECK: true,
    NEXT_PUBLIC_SBOLD: "",
    NEXT_PUBLIC_SUBGRAPH_CHECK: false,
    NEXT_PUBLIC_TROVE_EXPLORER_0: "",
    NEXT_PUBLIC_TROVE_EXPLORER_1: "",
    NEXT_PUBLIC_V1_STABILITY_POOL_CHECK: false,
    NEXT_PUBLIC_V1_STAKING_CHECK: false,
    NEXT_PUBLIC_YBOLD: false,
    NEXT_PUBLIC_CONTRACT_BOLD_TOKEN: manifest.stablecoin,
    NEXT_PUBLIC_CONTRACT_COLLATERAL_REGISTRY: manifest.collateralRegistry,
    NEXT_PUBLIC_CONTRACT_DEBT_IN_FRONT_HELPER: manifest.debtInFrontHelper,
    NEXT_PUBLIC_CONTRACT_EXCHANGE_HELPERS: manifest.disabledExchange,
    NEXT_PUBLIC_CONTRACT_EXCHANGE_HELPERS_V2: manifest.disabledExchange,
    NEXT_PUBLIC_CONTRACT_GOVERNANCE: ZERO_ADDRESS,
    NEXT_PUBLIC_CONTRACT_HINT_HELPERS: manifest.hintHelpers,
    NEXT_PUBLIC_CONTRACT_LQTY_STAKING: ZERO_ADDRESS,
    NEXT_PUBLIC_CONTRACT_LQTY_TOKEN: ZERO_ADDRESS,
    NEXT_PUBLIC_CONTRACT_LUSD_TOKEN: ZERO_ADDRESS,
    NEXT_PUBLIC_CONTRACT_MULTI_TROVE_GETTER: manifest.multiTroveGetter,
    NEXT_PUBLIC_CONTRACT_REDEMPTION_HELPER: manifest.redemptionHelper,
    NEXT_PUBLIC_CONTRACT_V1_STABILITY_POOL: ZERO_ADDRESS,
    NEXT_PUBLIC_CONTRACT_WETH: manifest.weth,
  };

  if (!isLocal) {
    appEnvVariables.NEXT_PUBLIC_CHAIN_BLOCK_EXPLORER = isRobinhoodMainnet
      ? "Robinhood Chain Explorer|https://robinhoodchain.blockscout.com"
      : "Robinhood Chain Testnet Explorer|https://explorer.testnet.chain.robinhood.com";
  }

  for (const [index, symbol] of STOCK_SYMBOLS.entries()) {
    const prefix = `NEXT_PUBLIC_COLL_${index}`;
    appEnvVariables[`${prefix}_TOKEN_ID`] = symbol;
    appEnvVariables[`${prefix}_IC_STRATEGIES`] = false;
    appEnvVariables[`${prefix}_CONTRACT_ACTIVE_POOL`] = manifest.activePools[index];
    appEnvVariables[`${prefix}_CONTRACT_ADDRESSES_REGISTRY`] = manifest.addressRegistries[index];
    appEnvVariables[`${prefix}_CONTRACT_BORROWER_OPERATIONS`] = manifest.borrowerOperations[index];
    appEnvVariables[`${prefix}_CONTRACT_COLL_SURPLUS_POOL`] = manifest.collSurplusPools[index];
    appEnvVariables[`${prefix}_CONTRACT_COLL_TOKEN`] = manifest.stockTokens[index];
    appEnvVariables[`${prefix}_CONTRACT_DEFAULT_POOL`] = manifest.defaultPools[index];
    appEnvVariables[`${prefix}_CONTRACT_LEVERAGE_ZAPPER`] = manifest.zappers[index];
    appEnvVariables[`${prefix}_CONTRACT_PRICE_FEED`] = manifest.priceFeeds[index];
    appEnvVariables[`${prefix}_CONTRACT_SORTED_TROVES`] = manifest.sortedTroves[index];
    appEnvVariables[`${prefix}_CONTRACT_STABILITY_POOL`] = manifest.stabilityPools[index];
    appEnvVariables[`${prefix}_CONTRACT_TROVE_MANAGER`] = manifest.troveManagers[index];
    appEnvVariables[`${prefix}_CONTRACT_TROVE_NFT`] = manifest.troveNFTs[index];
  }

  return appEnvVariables;
}

const ownableAbi = parseAbi([
  "function owner() view returns (address)",
]);
const stablecoinAbi = parseAbi([
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function collateralRegistryAddress() view returns (address)",
  "function owner() view returns (address)",
]);
const collateralRegistryAbi = parseAbi([
  "function totalCollaterals() view returns (uint256)",
  "function boldToken() view returns (address)",
]);
const addressesRegistryAbi = parseAbi([
  "function collToken() view returns (address)",
  "function borrowerOperations() view returns (address)",
  "function troveManager() view returns (address)",
  "function troveNFT() view returns (address)",
  "function stabilityPool() view returns (address)",
  "function priceFeed() view returns (address)",
  "function activePool() view returns (address)",
  "function defaultPool() view returns (address)",
  "function gasPoolAddress() view returns (address)",
  "function collSurplusPool() view returns (address)",
  "function sortedTroves() view returns (address)",
  "function collateralRegistry() view returns (address)",
  "function boldToken() view returns (address)",
  "function WETH() view returns (address)",
]);
const stockPriceFeedAbi = parseAbi([
  "function stockToken() view returns (address)",
  "function lastGoodPrice() view returns (uint256)",
]);

const sameAddress = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export async function verifyStockDeployment(manifest: StockDeploymentManifest, rpcUrl: string) {
  const client = createPublicClient({ transport: http(rpcUrl) });
  const chainId = await client.getChainId();
  if (chainId !== manifest.chainId) {
    throw new Error(`Deployment verification failed: expected chain ${manifest.chainId}, received ${chainId}`);
  }

  const codeTargets = new Set([
    manifest.stablecoin,
    manifest.collateralRegistry,
    manifest.hintHelpers,
    manifest.multiTroveGetter,
    manifest.debtInFrontHelper,
    manifest.redemptionHelper,
    manifest.disabledExchange,
    manifest.weth,
    ...manifest.stockTokens,
    ...manifest.addressRegistries,
    ...manifest.borrowerOperations,
    ...manifest.stabilityPools,
    ...manifest.troveNFTs,
    ...manifest.activePools,
    ...manifest.defaultPools,
    ...manifest.gasPools,
    ...manifest.collSurplusPools,
    ...manifest.sortedTroves,
    ...manifest.troveManagers,
    ...manifest.zappers,
    ...manifest.priceFeeds,
  ]);

  for (const address of codeTargets) {
    const bytecode = await client.getBytecode({ address });
    if (!bytecode || bytecode === "0x") {
      throw new Error(`Deployment verification failed: no bytecode at ${address}`);
    }
  }

  const [name, symbol, stablecoinRegistry, stablecoinOwner, totalCollaterals, registryStablecoin] = await Promise.all([
    client.readContract({ address: manifest.stablecoin, abi: stablecoinAbi, functionName: "name" }),
    client.readContract({ address: manifest.stablecoin, abi: stablecoinAbi, functionName: "symbol" }),
    client.readContract({
      address: manifest.stablecoin,
      abi: stablecoinAbi,
      functionName: "collateralRegistryAddress",
    }),
    client.readContract({ address: manifest.stablecoin, abi: ownableAbi, functionName: "owner" }),
    client.readContract({
      address: manifest.collateralRegistry,
      abi: collateralRegistryAbi,
      functionName: "totalCollaterals",
    }),
    client.readContract({
      address: manifest.collateralRegistry,
      abi: collateralRegistryAbi,
      functionName: "boldToken",
    }),
  ]);
  if (name !== "rUSD Stablecoin" || symbol !== "rUSD") {
    throw new Error(`Deployment verification failed: unexpected stablecoin identity ${name} (${symbol})`);
  }
  if (!sameAddress(stablecoinRegistry, manifest.collateralRegistry)) {
    throw new Error("Deployment verification failed: stablecoin registry mismatch");
  }
  if (!sameAddress(stablecoinOwner, ZERO_ADDRESS)) {
    throw new Error("Deployment verification failed: stablecoin ownership was not renounced");
  }
  if (totalCollaterals !== 10n || !sameAddress(registryStablecoin, manifest.stablecoin)) {
    throw new Error("Deployment verification failed: collateral registry wiring mismatch");
  }

  for (let index = 0; index < manifest.addressRegistries.length; index++) {
    const address = manifest.addressRegistries[index];
    const reads = await Promise.all([
      client.readContract({ address, abi: ownableAbi, functionName: "owner" }),
      client.readContract({ address, abi: addressesRegistryAbi, functionName: "collToken" }),
      client.readContract({ address, abi: addressesRegistryAbi, functionName: "borrowerOperations" }),
      client.readContract({ address, abi: addressesRegistryAbi, functionName: "troveManager" }),
      client.readContract({ address, abi: addressesRegistryAbi, functionName: "troveNFT" }),
      client.readContract({ address, abi: addressesRegistryAbi, functionName: "stabilityPool" }),
      client.readContract({ address, abi: addressesRegistryAbi, functionName: "priceFeed" }),
      client.readContract({ address, abi: addressesRegistryAbi, functionName: "activePool" }),
      client.readContract({ address, abi: addressesRegistryAbi, functionName: "defaultPool" }),
      client.readContract({ address, abi: addressesRegistryAbi, functionName: "gasPoolAddress" }),
      client.readContract({ address, abi: addressesRegistryAbi, functionName: "collSurplusPool" }),
      client.readContract({ address, abi: addressesRegistryAbi, functionName: "sortedTroves" }),
      client.readContract({ address, abi: addressesRegistryAbi, functionName: "collateralRegistry" }),
      client.readContract({ address, abi: addressesRegistryAbi, functionName: "boldToken" }),
      client.readContract({ address, abi: addressesRegistryAbi, functionName: "WETH" }),
      client.readContract({ address: manifest.priceFeeds[index], abi: stockPriceFeedAbi, functionName: "stockToken" }),
      client.readContract({
        address: manifest.priceFeeds[index],
        abi: stockPriceFeedAbi,
        functionName: "lastGoodPrice",
      }),
    ]);
    const expected = [
      ZERO_ADDRESS,
      manifest.stockTokens[index],
      manifest.borrowerOperations[index],
      manifest.troveManagers[index],
      manifest.troveNFTs[index],
      manifest.stabilityPools[index],
      manifest.priceFeeds[index],
      manifest.activePools[index],
      manifest.defaultPools[index],
      manifest.gasPools[index],
      manifest.collSurplusPools[index],
      manifest.sortedTroves[index],
      manifest.collateralRegistry,
      manifest.stablecoin,
      manifest.weth,
      manifest.stockTokens[index],
    ];
    for (let readIndex = 0; readIndex < expected.length; readIndex++) {
      if (!sameAddress(String(reads[readIndex]), expected[readIndex])) {
        throw new Error(`Deployment verification failed: branch ${index} wiring mismatch at check ${readIndex}`);
      }
    }
    if ((reads[16] as bigint) <= 0n) {
      throw new Error(`Deployment verification failed: branch ${index} has no usable initial price`);
    }
  }

  console.log(`Verified ${manifest.addressRegistries.length} Stock Token branches on chain ${chainId}.`);
}

function contractNameToAppEnvVariable(contractName: string, prefix: string = "") {
  prefix = `NEXT_PUBLIC_${prefix}`;
  switch (contractName) {
    // protocol contracts
    case "boldToken":
      return `${prefix}_BOLD_TOKEN`;
    case "collateralRegistry":
      return `${prefix}_COLLATERAL_REGISTRY`;
    case "hintHelpers":
      return `${prefix}_HINT_HELPERS`;
    case "multiTroveGetter":
      return `${prefix}_MULTI_TROVE_GETTER`;
    case "debtInFrontHelper":
      return `${prefix}_DEBT_IN_FRONT_HELPER`;
    case "exchangeHelpers":
      return `${prefix}_EXCHANGE_HELPERS`;
    case "exchangeHelpersV2":
      return `${prefix}_EXCHANGE_HELPERS_V2`;
    case "redemptionHelper":
      return `${prefix}_REDEMPTION_HELPER`;

    // collateral contracts
    case "activePool":
      return `${prefix}_ACTIVE_POOL`;
    case "addressesRegistry":
      return `${prefix}_ADDRESSES_REGISTRY`;
    case "borrowerOperations":
      return `${prefix}_BORROWER_OPERATIONS`;
    case "collSurplusPool":
      return `${prefix}_COLL_SURPLUS_POOL`;
    case "collToken":
      return `${prefix}_COLL_TOKEN`;
    case "defaultPool":
      return `${prefix}_DEFAULT_POOL`;
    case "leverageZapper":
      return `${prefix}_LEVERAGE_ZAPPER`;
    case "priceFeed":
      return `${prefix}_PRICE_FEED`;
    case "sortedTroves":
      return `${prefix}_SORTED_TROVES`;
    case "stabilityPool":
      return `${prefix}_STABILITY_POOL`;
    case "troveManager":
      return `${prefix}_TROVE_MANAGER`;
    case "troveNFT":
      return `${prefix}_TROVE_NFT`;

    // governance contracts
    case "LUSDToken":
      return `${prefix}_LUSD_TOKEN`;
    case "LQTYToken":
      return `${prefix}_LQTY_TOKEN`;
    case "stakingV1":
      return `${prefix}_LQTY_STAKING`;
    case "governance":
      return `${prefix}_GOVERNANCE`;
  }
  return null;
}

export function parseDeploymentManifest(content: string): DeploymentManifest | StockDeploymentManifest {
  if (!content.trim()) {
    console.error("\nNo deployment manifest provided.\n");
    process.exit(1);
  }

  let json: unknown;
  try {
    json = JSON.parse(content);
  } catch (error) {
    console.error("\nInvalid format provided.\n");
    process.exit(1);
  }

  const manifest = z.union([ZDeploymentManifest, ZStockDeploymentManifest]).safeParse(json);
  if (!manifest.success) {
    console.error("\nInvalid deployment manifest provided.\n");
    console.error(
      manifest.error.errors.map((error) => {
        return `${error.path.join(".")}: ${error.message} (${error.code})`;
      }).join("\n"),
    );
    console.error("");
    console.error("Received:");
    console.error(JSON.stringify(json, null, 2));

    process.exit(1);
  }

  return manifest.data;
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
