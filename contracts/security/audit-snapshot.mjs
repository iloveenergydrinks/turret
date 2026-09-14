// Read-only mainnet evidence. This script has no wallet, signer or write RPC.
import { createRequire } from 'node:module';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { vaultAbi, marketFromTuple } from '../../services/liquidator/src/abi.mjs';
const require = createRequire(new URL('../../services/liquidator/package.json', import.meta.url));
const { createPublicClient, http, parseAbi, keccak256 } = require('viem');
const root = new URL('../../', import.meta.url);
const vault = '0x576c510e9A268B06448f67598B7BF1ed33388e20';
const abi = parseAbi([
  'function aggregator() view returns(address)',
  'function description() view returns(string)',
  'function decimals() view returns(uint8)',
  'function symbol() view returns(string)',
  'function oraclePaused() view returns(bool)',
  'function latestRoundData() view returns(uint80,int256,uint256,uint256,uint80)',
]);
try {
  if (!process.env.AUDIT_RPC_URL) throw new Error('Missing audit RPC');
  const client = createPublicClient({ transport: http(process.env.AUDIT_RPC_URL, { timeout: 15000, retryCount: 1 }) });
  if (await client.getChainId() !== 4663) throw new Error('Wrong chain');
  const block = await client.getBlock();
  const read = (address, abi_, functionName, args = []) => client.readContract({address,abi:abi_,functionName,args,blockNumber:block.number});
  const code = await client.getCode({ address: vault, blockNumber: block.number });
  const artifact = JSON.parse(readFileSync(new URL('contracts/out/DockyardUSDGCreditVault.sol/DockyardUSDGCreditVault.json', root)));
  const mask = hex => {
    const bytes = Buffer.from(hex.replace(/^0x/, ''), 'hex');
    for (const references of Object.values(artifact.deployedBytecode.immutableReferences)) {
      for (const {start,length} of references) bytes.fill(0,start,start+length);
    }
    return bytes.toString('hex');
  };
  const settings = {};
  for (const fn of ['owner','paused','usdg','usdgTo18Scale','originationFeeBps','oracleStaleness','availableLiquidity','totalDebt','collateralCount']) {
    settings[fn] = await read(vault,vaultAbi,fn);
  }
  const markets = [];
  for (let i = 0; i < Number(settings.collateralCount); i++) {
    const collateral = await read(vault,vaultAbi,'collateralAt',[BigInt(i)]);
    const config = marketFromTuple(collateral,await read(vault,vaultAbi,'markets',[collateral]));
    const market = { ...config, symbol: await read(collateral,abi,'symbol'), oraclePaused: await read(collateral,abi,'oraclePaused'), debt: await read(vault,vaultAbi,'marketDebt',[collateral]) };
    for (const role of ['primary','secondary']) {
      const address = config[`${role}Oracle`];
      const [aggregator,description,decimals,round] = await Promise.all(['aggregator','description','decimals','latestRoundData'].map(fn=>read(address,abi,fn)));
      market[role] = { address,aggregator,description,decimals,roundId:round[0],answer:round[1],updatedAt:round[3],ageSeconds:block.timestamp-round[3] };
    }
    market.sameUnderlyingAggregator = market.primary.aggregator.toLowerCase() === market.secondary.aggregator.toLowerCase();
    markets.push(market);
  }
  if ((await client.getBlock({blockNumber:block.number})).hash !== block.hash) throw new Error('Reorg during snapshot');
  const evidence = {
    capturedAt:new Date().toISOString(), chainId:4663, vault, block:block.number, blockHash:block.hash, blockTimestamp:block.timestamp,
    runtimeKeccak256:keccak256(code), runtimeBytes:(code.length-2)/2,
    sourceSha256:createHash('sha256').update(readFileSync(new URL('contracts/src/DockyardUSDGCreditVault.sol',root))).digest('hex'),
    matchesLocalArtifactIgnoringImmutableSlots:mask(code) === mask(artifact.deployedBytecode.object),
    settings,markets,
  };
  const directory = new URL('docs/security/evidence/2026-09-02/',root);
  mkdirSync(directory,{recursive:true});
  writeFileSync(new URL('mainnet-snapshot.json',directory),JSON.stringify(evidence,(_,v)=>typeof v === 'bigint'?v.toString():v,2)+'\n');
  console.log(JSON.stringify({block:block.number.toString(),runtimeHash:evidence.runtimeKeccak256,artifactMatches:evidence.matchesLocalArtifactIgnoringImmutableSlots,markets:markets.length,sharedAggregatorPairs:markets.filter(x=>x.sameUnderlyingAggregator).length,output:fileURLToPath(new URL('mainnet-snapshot.json',directory))}));
} catch (error) {
  console.error(`Read-only snapshot failed: ${error.name}`); // Never disclose the credential-bearing RPC URL.
  process.exitCode = 1;
}
