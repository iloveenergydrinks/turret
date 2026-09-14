import { keccak256, toHex, type Address, type EIP1193Provider } from 'viem';
import { P2PAlerts } from '../p2p/P2PAlerts';
import type { P2PAlertScope } from '../p2p/alerts-api';
import type { NFTConfig } from './client';

export function nftAlertScope(config:NFTConfig):P2PAlertScope {
  const markets=[{address:config.address.toLowerCase(),version:1,chainId:config.chainId,loanToken:config.loanToken.toLowerCase(),
    runtimeHash:config.runtimeHash.toLowerCase(),startBlock:config.startBlock,loanDecimals:6,loanSymbol:'USDG',collateralKind:'erc721'}];
  return {protocol:'nft',chainId:config.chainId,scope:keccak256(toHex(JSON.stringify(markets))),markets};
}
export function NFTAlerts({config,account,provider}:{config:NFTConfig;account?:Address|null;provider?:EIP1193Provider|null}) {
  return <section className="nft-explainer" aria-label="NFT loan reminders">
    <h2>NFT loan reminders</h2>
    <P2PAlerts account={account} provider={provider} markets={[]} scopeOverride={nftAlertScope(config)} serviceUrl="/api/nft-alerts" />
  </section>;
}
