import { $, echo, fs, minimist, path, question } from "zx";

const LATEST_DEPLOYMENT_CONTEXT_PATH = path.join(__dirname, "../../contracts/deployment-context-latest.json");
const STOCK_SANDCASTLE_MANIFEST_PATH = path.join(__dirname, "../../contracts/deployment-stock-sandcastle.json");
const STOCK_PRODUCTION_MANIFEST_PATH = path.join(
  __dirname,
  "../../contracts/deployment-stock-robinhood-mainnet.json",
);
const NETWORKS_JSON_PATH = path.join(__dirname, "../networks.json");
const GENERATED_NETWORKS_JSON_PATH = path.join(__dirname, "../networks-generated.json");
const SUBGRAPH_MANIFEST_PATH = path.join(__dirname, "../subgraph.yaml");
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

const HELP = `
deploy-subgraph - deploy the Liquity v2 subgraph

Usage:
  ./deploy-subgraph [NETWORK_PRESET] [OPTIONS]

Arguments:
  NETWORK_PRESET  A network preset, which is a shorthand for setting certain options.
                  Options take precedence over network presets. Available presets:
                  - local: Deploy to a local network
                  - sepolia: Deploy to Ethereum Sepolia
                  - stock-sandcastle: Build or deploy the Stock Token sandcastle
                  - stock-production: Build or deploy the Robinhood mainnet rUSD subgraph
                  - mainnet: Deploy to the Ethereum mainnet (not implemented)
                  - liquity-testnet: Deploy to the Liquity v2 testnet (not implemented)


Options:
  --create                                 Create the subgraph before deploying.
  --build-only                             Build without creating or deploying.
  --debug                                  Show debug output.
  --graph-node <GRAPH_NODE_URL>            The Graph Node URL to use.
  --help, -h                               Show this help message.
  --ipfs-node <IPFS_NODE_URL>              The IPFS node URL to use.
  --manifest <MANIFEST_JSON>               Stock sandcastle deployment manifest.
  --name <SUBGRAPH_NAME>                   The subgraph name to use.
  --network <SUBGRAPH_NETWORK>             The subgraph network to use.
  --version <SUBGRAPH_VERSION>             The subgraph version to use.
`;

const argv = minimist(process.argv.slice(2), {
  alias: {
    h: "help",
  },
  boolean: [
    "create",
    "build-only",
    "debug",
    "help",
  ],
  string: [
    "graph-node",
    "ipfs-node",
    "manifest",
    "name",
    "network",
    "version",
  ],
});

export async function main() {
  const options = {
    debug: argv["debug"],
    help: argv["help"],
    create: argv["create"],
    buildOnly: argv["build-only"],
    graphNode: argv["graph-node"],
    ipfsNode: argv["ipfs-node"],
    manifest: argv["manifest"],
    name: argv["name"],
    network: argv["network"], // subgraph network, not to be confused with the network preset
    version: argv["version"],
  };

  const [networkPreset] = argv._;

  if (options.help) {
    echo`${HELP}`;
    process.exit(0);
  }

  let isLocal = false;
  let isStockDeployment = false;
  let requiresExplicitStockNodes = false;

  if (networkPreset === "local") {
    options.name ??= "liquity2/liquity2";
    options.graphNode ??= "http://localhost:8020/";
    options.ipfsNode ??= "http://localhost:5001/";
    options.network ??= "mainnet";
    isLocal = true;
  }
  if (networkPreset === "sepolia") {
    options.name ??= "liquity2-sepolia-preview";
    options.network ??= "sepolia";
  }
  if (networkPreset === "stock-sandcastle") {
    options.name ??= "rusd-stock-sandcastle";
    options.network ??= "robinhood-testnet";
    options.manifest ??= STOCK_SANDCASTLE_MANIFEST_PATH;
    isStockDeployment = true;
    requiresExplicitStockNodes = true;
  }
  if (networkPreset === "stock-production") {
    options.name ??= "rusd-robinhood";
    options.network ??= "robinhood";
    options.manifest ??= STOCK_PRODUCTION_MANIFEST_PATH;
    isStockDeployment = true;
  }
  if (networkPreset === "mainnet-relaunch") {
    options.name ??= "liquity-2-relaunch";
    options.network ??= "mainnet";
  }
  if (networkPreset === "mainnet-legacy") {
    options.name ??= "liquity2-mainnet";
    options.network ??= "mainnet";
  }

  if (!options.name) {
    throw new Error("--name <SUBGRAPH_NAME> is required");
  }
  if (!options.network) {
    throw new Error("--network <SUBGRAPH_NETWORK> is required");
  }
  if (!options.graphNode && !options.network) {
    throw new Error("--graph-node <GRAPH_NODE_URL> is required");
  }
  if (!options.ipfsNode && !options.network) {
    throw new Error("--ipfs-node <IPFS_NODE_URL> is required");
  }
  if (requiresExplicitStockNodes && !options.buildOnly && (!options.graphNode || !options.ipfsNode)) {
    throw new Error("Stock sandcastle deployment requires explicit --graph-node and --ipfs-node endpoints");
  }

  const graphBuildCommand: string[] = [
    "graph",
    "build",
    "--network",
    options.network,
    "--network-file",
    GENERATED_NETWORKS_JSON_PATH,
  ];
  const graphCodegenCommand = ["graph", "codegen"];

  const graphCreateCommand: null | string[] = !options.create ? null : [
    "graph",
    "create",
    ...(options.graphNode ? ["--node", options.graphNode] : []),
    options.name,
  ];

  const graphDeployCommand: string[] = [
    "graph",
    "deploy",
    "--network-file",
    GENERATED_NETWORKS_JSON_PATH,
  ];

  if (options.graphNode) graphDeployCommand.push("--node", options.graphNode);
  if (options.network) graphDeployCommand.push("--network", options.network);
  if (options.version) graphDeployCommand.push("--version-label", options.version);
  if (options.ipfsNode) graphDeployCommand.push("--ipfs", options.ipfsNode);

  graphDeployCommand.push(options.name);

  if (isLocal) {
    await updateNetworksWithLocalBoldToken();
  }

  await generateNetworksJson({
    isLocal,
    stockManifestPath: isStockDeployment ? options.manifest : undefined,
    stockNetwork: isStockDeployment ? options.network : undefined,
  });

  echo`
${options.buildOnly ? "Building" : "Deploying"} subgraph:

  NAME:               ${options.name}
  VERSION:            ${options.version}
  GRAPH NODE:         ${options.graphNode}
  IPFS NODE:          ${options.ipfsNode}
  CREATE:             ${options.create ? "yes" : "no"}
  DEBUG:              ${options.debug ? "yes" : "no"}
`;

  $.verbose = options.debug;
  const originalSubgraphManifest = await fs.readFile(SUBGRAPH_MANIFEST_PATH, "utf8");

  try {
    await $`pnpm ${graphCodegenCommand}`;
    echo("");
    echo("Subgraph code generation complete.");
    echo("");

    await $`pnpm ${graphBuildCommand}`;
    echo("");
    echo("Subgraph build complete.");
    echo("");

    if (options.buildOnly) {
      return;
    }

    if (graphCreateCommand) {
      await $`pnpm ${graphCreateCommand}`;
    }
    echo("");
    echo("Subgraph create complete.");
    echo("");

    await $`pnpm ${graphDeployCommand}`;
    echo("");
    echo("Subgraph deployment complete.");
    echo("");
  } finally {
    await fs.writeFile(SUBGRAPH_MANIFEST_PATH, originalSubgraphManifest);
  }
}

async function generateNetworksJson({
  isLocal = false,
  stockManifestPath,
  stockNetwork,
}: {
  isLocal?: boolean;
  stockManifestPath?: string;
  stockNetwork?: string;
}) {
  const networksJson = JSON.parse(await fs.readFile(NETWORKS_JSON_PATH, "utf8"));
  const stockNetworkConfig = stockManifestPath && stockNetwork
    ? { [stockNetwork]: await stockManifestToNetworkConfig(stockManifestPath) }
    : {};
  return fs.writeFile(
    GENERATED_NETWORKS_JSON_PATH,
    JSON.stringify(
      {
        ...networksJson,
        ...stockNetworkConfig,
        mainnet: isLocal ? networksJson.local : networksJson.mainnet,
      },
      null,
      2,
    ),
  );
}

async function stockManifestToNetworkConfig(manifestPath: string) {
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  if (manifest.chainId !== 31337 && manifest.chainId !== 4663 && manifest.chainId !== 46630) {
    throw new Error(`Unsupported stock deployment chain ID: ${manifest.chainId}`);
  }
  if (typeof manifest.stablecoin !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(manifest.stablecoin)) {
    throw new Error("Invalid stablecoin address in stock deployment manifest");
  }

  const startBlock = manifest.deploymentBlock ?? 0;
  if (!Number.isSafeInteger(startBlock) || startBlock < 0) {
    throw new Error("Invalid deployment block in stock deployment manifest");
  }
  if (startBlock === 0) {
    console.warn("Stock sandcastle manifest has no deploymentBlock; indexing will start at block 0.");
  }

  return {
    BoldToken: {
      address: manifest.stablecoin,
      startBlock,
    },
    Governance: {
      address: ZERO_ADDRESS,
      startBlock,
    },
  };
}

async function updateNetworksWithLocalBoldToken() {
  const networksJson = JSON.parse(await fs.readFile(NETWORKS_JSON_PATH, "utf8"));
  const latestDeploymentContext = getLatestDeploymentContext();

  const deployedAddress = latestDeploymentContext?.protocolContracts.BoldToken;
  if (!deployedAddress || (networksJson.local.BoldToken.address === deployedAddress)) {
    return;
  }

  const answer = await question(
    `\nNew BoldToken detected (${deployedAddress}) for local network. Update networks.json? [Y/n] `,
  );

  const confirmed = answer === "" || answer.toLowerCase() === "y" || answer.toLowerCase() === "yes";

  if (!confirmed) {
    return;
  }

  networksJson.local.BoldToken.address = deployedAddress;
  await fs.writeFile(NETWORKS_JSON_PATH, JSON.stringify(networksJson, null, 2));

  console.log("");
  console.log("networks.json updated with local BoldToken:", deployedAddress);
}

function getLatestDeploymentContext() {
  try {
    return JSON.parse(fs.readFileSync(LATEST_DEPLOYMENT_CONTEXT_PATH, "utf8"));
  } catch (_) {
    return null;
  }
}
