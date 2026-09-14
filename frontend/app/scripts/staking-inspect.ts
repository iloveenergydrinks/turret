// Read-only deployment verifier. Never signs or submits a transaction.
import { readFileSync, writeFileSync } from "node:fs";
import { createPublicClient, getAddress, http, keccak256, parseAbi, encodeFunctionData, type Hex } from "viem";
import { readStaking, routerAbi, tokenAbi, TREASURY, USDG, type StakingDeployment } from "../src/staking/client";
const config = JSON.parse(readFileSync(new URL("../../../contracts/rewards/config/staking-pools.json", import.meta.url), "utf8"));
const router = getAddress(process.argv[2] ?? "");
const startBlock = process.argv[3];
if (!startBlock || !/^\d+$/.test(startBlock)) throw Error("Usage: tsx scripts/staking-inspect.ts ROUTER DEPLOYMENT_BLOCK [OUTPUT_JSON]");
const client = createPublicClient({ transport: http(process.env.STAKING_RPC_URL ?? "https://turret.capital/api/rpc") });
const block = await client.getBlock();
if (await client.getChainId() !== 4663 || block.number === null) throw Error("Wrong chain or unavailable block");
const blockNumber = block.number;
const address = await client.readContract({ address: router, abi: routerAbi, functionName: "staking", blockNumber });
async function verifyRuntime(target: Hex, name: string) {
  const code = await client.getCode({ address: target, blockNumber });
  if (!code || code === "0x") throw Error(`${name} has no deployed code`);
  const artifact = JSON.parse(readFileSync(new URL(`../../../contracts/rewards/out/${name}.sol/${name}.json`, import.meta.url), "utf8"));
  const expected = artifact.deployedBytecode.object.replace(/^0x/, "").split("");
  const actual = code.slice(2).split("");
  if (expected.length !== actual.length) throw Error(`${name} runtime length mismatch`);
  for (const refs of Object.values(artifact.deployedBytecode.immutableReferences) as { start: number; length: number }[][]) {
    for (const { start, length } of refs) for (let i = start * 2; i < (start + length) * 2; i++) { expected[i] = "0"; actual[i] = "0"; }
  }
  if (expected.join("") !== actual.join("")) throw Error(`${name} runtime does not match the compiled artifact`);
  return keccak256(code);
}
const d: StakingDeployment = { address, router, startBlock, runtimeHash: await verifyRuntime(address, "TurretStaking"), routerRuntimeHash: await verifyRuntime(router, "TurretFeeRouter"), tokenRuntimeHash: config.stakingTokenHash, usdgRuntimeHash: config.rewardTokenHash };
const snapshot = await readStaking(client, d);
const poolCount = await client.readContract({ address: router, abi: routerAbi, functionName: "poolCount", blockNumber });
if (poolCount !== BigInt(config.pools.length)) throw Error("Pool allowlist length mismatch");
const poolAbi = parseAbi(["function asset() view returns(address)", "function feeRecipient() view returns(address)", "function revenueFeeBps() view returns(uint16)", "function protocolFees() view returns(uint256)"]);
const fees = [];
for (let i = 0; i < config.pools.length; i++) {
  const pool = getAddress(config.pools[i]);
  const [configured, code, expectedHash, asset, treasury, bps, pending] = await Promise.all([
    client.readContract({ address: router, abi: routerAbi, functionName: "pools", args: [BigInt(i)], blockNumber }),
    client.getCode({ address: pool, blockNumber }),
    client.readContract({ address: router, abi: routerAbi, functionName: "poolCodeHash", args: [pool], blockNumber }),
    client.readContract({ address: pool, abi: poolAbi, functionName: "asset", blockNumber }),
    client.readContract({ address: pool, abi: poolAbi, functionName: "feeRecipient", blockNumber }),
    client.readContract({ address: pool, abi: poolAbi, functionName: "revenueFeeBps", blockNumber }),
    client.readContract({ address: pool, abi: poolAbi, functionName: "protocolFees", blockNumber }),
  ]);
  if (getAddress(configured) !== pool || !code || keccak256(code) !== config.poolHashes[i] || expectedHash !== config.poolHashes[i]
    || getAddress(asset) !== USDG || getAddress(treasury) !== TREASURY || bps !== 1000) throw Error(`Pool ${i} identity mismatch`);
  fees.push({ symbol: config.symbols[i], pool, pendingUSDGBaseUnits: pending.toString(), collectCall: { to: router, value: "0", data: encodeFunctionData({ abi: routerAbi, functionName: "collect", args: [pool] }) } });
}
if ((await client.getBlock({ blockNumber })).hash !== block.hash) throw Error("Verification block changed");
const [collected, reported, distributed] = await Promise.all([
  client.readContract({ address: router, abi: routerAbi, functionName: "totalCollected", blockNumber }),
  client.readContract({ address: router, abi: routerAbi, functionName: "totalTreasuryReported", blockNumber }),
  client.readContract({ address: router, abi: routerAbi, functionName: "totalDistributed", blockNumber }),
]);
const halfRemainder = collected + reported - 2n * distributed;
if (halfRemainder < 0n || halfRemainder > 1n) throw Error("Fee split accounting mismatch");
const allowanceBaseUnits = (fees.reduce((sum, f) => sum + BigInt(f.pendingUSDGBaseUnits), 0n) + halfRemainder) / 2n;
const manifest = { chainId: 4663, stakingToken: config.stakingToken, rewardToken: config.rewardToken, treasury: config.treasury, stakerShareBps: 5000, deployment: d };
const result = { status: "verified-candidate-not-published", manifest, verificationBlock: blockNumber.toString(), snapshot,
  treasuryApproval: { from: TREASURY, to: USDG, value: "0", amountBaseUnits: allowanceBaseUnits.toString(), data: encodeFunctionData({ abi: tokenAbi, functionName: "approve", args: [router, allowanceBaseUnits] }), note: "Snapshot-sized allowance only. Review a separately chosen operating limit before approving future fees. A zero amount revokes approval." }, fees };
const output = process.argv[4] ?? "../../output/turret-staking-20260909/deployment-candidate.json";
writeFileSync(output, JSON.stringify(result, (_, value) => typeof value === "bigint" ? value.toString() : value, 2) + "\n");
console.log(`Verified staking and fee router; candidate written to ${output}. No transactions submitted.`);
