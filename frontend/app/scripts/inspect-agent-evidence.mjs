// Read-only snapshot. No wallet, signing, or transaction submission.
// Run from frontend/app: node scripts/inspect-agent-evidence.mjs
import { createPublicClient, http, keccak256, parseAbi } from "viem";

const rpc = "https://rpc.mainnet.chain.robinhood.com";
const vault = "0x576c510e9A268B06448f67598B7BF1ed33388e20";
const client = createPublicClient({ transport: http(rpc, { timeout: 20_000 }) });
const abi = parseAbi([
  "function owner() view returns (address)",
  "function usdg() view returns (address)",
  "function paused() view returns (bool)",
  "function originationFeeBps() view returns (uint16)",
  "function oracleStaleness() view returns (uint256)",
  "function availableLiquidity() view returns (uint256)",
  "function totalDebt() view returns (uint256)",
  "function collateralCount() view returns (uint256)",
  "function collateralAt(uint256) view returns (address)",
  "function markets(address) view returns (address primaryOracle, address secondaryOracle, uint128 debtCeiling, uint16 maxLtvBps, uint16 liquidationLtvBps, uint16 liquidationBonusBps, uint16 maxOracleDeviationBps, uint8 primaryOracleDecimals, uint8 secondaryOracleDecimals, bool enabled)",
  "function marketDebt(address) view returns (uint256)",
]);
const erc20 = parseAbi(["function symbol() view returns (string)", "function decimals() view returns (uint8)"]);
const chainId = await client.getChainId();
if (chainId !== 4663) throw new Error("Wrong chain");
const blockArgument = process.argv.find((argument) => argument.startsWith("--block="));
if (blockArgument && !/^--block=\d+$/.test(blockArgument)) throw new Error("Invalid block number");
const block = await client.getBlock(blockArgument ? { blockNumber: BigInt(blockArgument.slice(8)) } : undefined);
const blockNumber = block.number;
const call = (functionName, args = []) => client.readContract({ address: vault, abi, functionName, args, blockNumber });
const bytecode = await client.getCode({ address: vault, blockNumber });
if (!bytecode || bytecode === "0x") throw new Error("No vault bytecode");
const state = Object.fromEntries(await Promise.all(
  ["owner", "usdg", "paused", "originationFeeBps", "oracleStaleness", "availableLiquidity", "totalDebt", "collateralCount"]
    .map(async (name) => [name, await call(name)]),
));
const usdgDecimals = await client.readContract({ address: state.usdg, abi: erc20, functionName: "decimals", blockNumber });
const markets = [];
for (let index = 0; index < Number(state.collateralCount); index++) {
  const collateral = await call("collateralAt", [BigInt(index)]);
  const [values, marketDebt, symbol] = await Promise.all([
    call("markets", [collateral]), call("marketDebt", [collateral]),
    client.readContract({ address: collateral, abi: erc20, functionName: "symbol", blockNumber }),
  ]);
  const names = ["primaryOracle", "secondaryOracle", "debtCeiling", "maxLtvBps", "liquidationLtvBps", "liquidationBonusBps", "maxOracleDeviationBps", "primaryOracleDecimals", "secondaryOracleDecimals", "enabled"];
  markets.push({ symbol, collateral, ...Object.fromEntries(names.map((name, i) => [name, values[i]])), marketDebt });
}
console.log(JSON.stringify({
  schemaVersion: 1,
  provenance: "Project-authored snapshot from read-only public RPC calls; not an audit or a live status feed.",
  rpc, chainId, blockNumber, blockHash: block.hash,
  blockTime: new Date(Number(block.timestamp) * 1000).toISOString(),
  vault, runtimeCodeKeccak256: keccak256(bytecode), usdgDecimals,
  units: "Debt, liquidity, and ceilings are raw USDG units. Risk ratios are basis points (10,000 = 100%).",
  ...state, markets,
}, (_, value) => typeof value === "bigint" ? value.toString() : value, 2));
