import { readFileSync } from 'node:fs';
import { isAddress, keccak256, toHex } from 'viem';

const address = value => typeof value === 'string' && isAddress(value,{strict:false}) && !/^0x0{40}$/i.test(value);
export function validateNFTAlertsRegistry(row,{allowLocal=false,confirmations=12}={}) {
  if (!row || row.version !== 1 || !address(row.address) || !address(row.loanToken)
    || row.address.toLowerCase() === row.loanToken.toLowerCase()
    || ![4663,...(allowLocal?[31337]:[])].includes(row.chainId) || row.loanDecimals !== 6
    || !/^0x[0-9a-f]{64}$/i.test(row.runtimeHash) || !/^(0|[1-9][0-9]{0,19})$/.test(row.startBlock)
    || !Number.isSafeInteger(confirmations) || confirmations < 1 || confirmations > 128) throw new Error('Invalid NFT alerts registry');
  // Scope covers all loans on this exact immutable manager. Collection admission changes
  // must not invalidate reminders for existing loans or reuse another manager's consent.
  const market={address:row.address.toLowerCase(),version:1,chainId:row.chainId,loanToken:row.loanToken.toLowerCase(),
    runtimeHash:row.runtimeHash.toLowerCase(),startBlock:row.startBlock,loanDecimals:6,loanSymbol:'USDG',collateralKind:'erc721'};
  const markets=[market],scope=keccak256(toHex(JSON.stringify(markets)));
  return {kind:'nft',vault:market.address,chainId:market.chainId,markets,scope,confirmations};
}
export function nftAlertsDeployment(env=process.env) {
  if(!env.ALERTS_NFT_REGISTRY_PATH)throw new Error('Explicit NFT registry required');
  return validateNFTAlertsRegistry(JSON.parse(readFileSync(env.ALERTS_NFT_REGISTRY_PATH,'utf8')),
    {allowLocal:env.ALERTS_NFT_ALLOW_LOCAL==='true',confirmations:Number(env.ALERTS_NFT_CONFIRMATIONS??12)});
}
export function bindNFTAlertsDeployment(store,deployment) {
  const previous=store.get('system','deployment');
  if((previous&&(previous.kind!=='nft'||previous.scope!==deployment.scope))
    ||(!previous&&['subscription','pending','challenge','session'].some(kind=>store.all(kind).length))) {
    throw new Error('NFT market scope changed; use a separate database and obtain fresh NFT consent');
  }
  store.put('system','deployment',{kind:'nft',scope:deployment.scope,chainId:deployment.chainId});
}
