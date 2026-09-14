import {keccak256,parseAbi} from 'viem';
import {isolatedConfigFromEnv} from '../../services/oracle-relay/src/isolated-config.mjs';
import {verifyIsolatedTargets} from '../../services/oracle-relay/src/isolated-publication.mjs';

const same=(a,b)=>typeof a==='string'&&typeof b==='string'&&a.toLowerCase()===b.toLowerCase();
const demand=(ok,message)=>{if(!ok)throw Error(message);};

/** Optional extension of paused-market commissioning. Verifies one exact
 * corroborated DEX + authenticated ratio path at the deployment verifier's block.
 * Returns observe-only candidates, not licensing, independence or activation approval. */
export async function verifyOracleWiring({config:c,oracle,client,blockNumber}) {
  demand(typeof blockNumber==='bigint'&&blockNumber>0n,'Pinned commissioning block required');
  demand(oracle&&Object.keys(oracle).length===3&&['manifest','dex','dexCodeHash'].every(k=>Object.hasOwn(oracle,k)),'Explicit oracle wiring required');
  demand(typeof oracle.dex==='string'&&/^0x[\da-f]{40}$/i.test(oracle.dex)&&!/^0x0{40}$/i.test(oracle.dex),'Explicit DEX oracle address required');
  demand(typeof oracle.dexCodeHash==='string'&&/^0x[\da-f]{64}$/i.test(oracle.dexCodeHash),'Explicit DEX oracle runtime required');
  const supplied=oracle.manifest;
  // Validate even fields not copied to the candidate: reject accidental secret
  // fields before any serialization. Placeholder credentials stay in memory only.
  isolatedConfigFromEnv({ORACLE_RPC_URL:'http://127.0.0.1',ORACLE_STATUS_TOKEN:'commissioning-placeholder-status-token',PYTH_API_KEY:'not-installed'},supplied);
  const {executionApproved:_approval,reviewDigest:_review,...base}=supplied;
  const manifest={...base,executionApproved:false};
  const parsed=isolatedConfigFromEnv({ORACLE_RPC_URL:'http://127.0.0.1',ORACLE_STATUS_TOKEN:'commissioning-placeholder-status-token',PYTH_API_KEY:'not-installed'},manifest);
  const p=manifest.publication,at={blockNumber};
  demand(same(manifest.guardian,c.credit.guardian),'Oracle guardian differs from market');
  demand(BigInt(manifest.startBlock)<=blockNumber,'Oracle start block is in the future');
  demand(same(p.adapter,c.credit.secondary)&&same(p.policy.collateral,c.credit.collateral)&&same(p.policy.usdg,c.credit.usdg),'Oracle publishes for a different market');
  demand(same(p.adapterCodeHash,c.pins.secondary)&&same(p.collateralCodeHash,c.pins.collateral)&&same(p.usdgCodeHash,c.pins.usdg),'Oracle pins differ from market pins');
  demand(new Set([p.hub,p.adapter,oracle.dex,c.credit.primary].map(a=>a.toLowerCase())).size===4,'Overlapping oracle components');
  for(const [address,pin] of [[c.credit.primary,c.pins.primary],[oracle.dex,oracle.dexCodeHash]]){
    const code=await client.getCode({address,...at});demand(code&&code!=='0x'&&same(keccak256(code),pin),'Oracle runtime mismatch');
  }
  await verifyIsolatedTargets(client,p,at);
  const read=(address,name,type='address')=>client.readContract({address,abi:parseAbi([`function ${name}() view returns(${type})`]),functionName:name,...at});
  const bindings=[
    [c.credit.primary,'referenceFeed',p.adapter],[c.credit.primary,'dex',oracle.dex],
    [oracle.dex,'collateral',c.credit.collateral],[oracle.dex,'usdg',c.credit.usdg],
    [oracle.dex,'intermediate',c.intermediate],[oracle.dex,'firstPool',c.firstPool],[oracle.dex,'secondPool',c.secondPool],
  ];
  for(const [address,name,expected] of bindings)demand(same(await read(address,name),expected),'Oracle reference or DEX route mismatch');
  for(const [address,name,expected] of [[c.credit.primary,'referenceCodeHash',p.adapterCodeHash],
    [c.credit.primary,'dexCodeHash',oracle.dexCodeHash],[oracle.dex,'firstCodeHash',c.pins.firstPool],[oracle.dex,'secondCodeHash',c.pins.secondPool]])
    demand(same(await read(address,name,'bytes32'),expected),'Nested oracle runtime pin mismatch');
  demand(Number(await read(c.credit.primary,'referenceDecimals','uint8'))===18,'Reference units mismatch');
  return {blockNumber,identityHash:parsed.identityHash,
    relayCandidate:{ORACLE_RELAY_MODE:'observe',ISOLATED_ORACLE_MANIFEST_JSON:JSON.stringify(manifest)},
    watchdogCandidate:{ISOLATED_ORACLE_EXPECTED_IDENTITY_HASH:parsed.identityHash},
    requiredConfiguration:['ORACLE_RPC_URL','PYTH_API_KEY','ORACLE_STATUS_TOKEN','ORACLE_DATA_DIR',
      'ISOLATED_ORACLE_STATUS_URL','ORACLE_WATCHDOG_DATA_DIR','operator notification credentials and recipients'],
    wiringVerified:true,oracleProviderAccessVerified:false,sourceIndependenceVerified:false,
    productionApproved:false,installed:false};
}
