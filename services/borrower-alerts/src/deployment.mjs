import {getAddress} from 'viem';
export const LEGACY_VAULT='0x576c510e9A268B06448f67598B7BF1ed33388e20';
export function alertsDeployment(env=process.env){
 const address=env.ALERTS_VAULT_ADDRESS,codeHash=env.ALERTS_VAULT_CODE_HASH;
 if(Boolean(address)!==Boolean(codeHash))throw new Error('Vault override requires pinned bytecode');
 if(codeHash&&!/^0x[0-9a-f]{64}$/i.test(codeHash))throw new Error('Invalid vault code hash');
 return {vault:address?getAddress(address):LEGACY_VAULT,codeHash};
}
export function bindDeployment(store,deployment){
 const previous=store.get('system','deployment');
 if(previous&&previous.vault.toLowerCase()!==deployment.vault.toLowerCase())throw new Error('Use a separate alerts database for a new vault');
 if(!previous&&deployment.vault.toLowerCase()!==LEGACY_VAULT.toLowerCase()&&store.all('subscription').length)throw new Error('Existing subscriptions belong to the legacy vault');
 store.put('system','deployment',{vault:deployment.vault,codeHash:deployment.codeHash??null});
}
