import {configFromEnv} from '../../liquidator/src/config.mjs';
import {keccak256} from './deps.mjs';
import {API3_SERVER,API3_SERVER_HASH,API3_SOURCE_REVISION} from './api3-usdg.mjs';
const address=x=>typeof x==='string'&&/^0x[\da-f]{40}$/i.test(x)&&!/^0x0{40}$/i.test(x);
const hash=x=>typeof x==='string'&&/^0x[\da-f]{64}$/i.test(x)&&!/^0x0{64}$/i.test(x);
const demand=ok=>{if(!ok)throw Error('Invalid API3 oracle configuration');};
const fields=(value,required,optional=[])=>demand(value&&typeof value==='object'&&!Array.isArray(value)
  &&required.every(k=>Object.hasOwn(value,k))&&Object.keys(value).every(k=>required.includes(k)||optional.includes(k)));

export function api3ConfigFromEnv(env,manifest){
  fields(manifest,['kind','chainId','startBlock','publication','relayAddress','guardian','keeper'],['executionApproved','reviewDigest']);
  demand(manifest.kind==='stock-api3-usdg'&&manifest.chainId===4663);
  fields(manifest.publication,['adapter','adapterCodeHash']);
  const p=manifest.publication;
  demand(address(p.adapter)&&hash(p.adapterCodeHash));
  demand([manifest.relayAddress,manifest.guardian,manifest.keeper].every(address));
  demand(new Set([p.adapter,API3_SERVER,manifest.relayAddress,manifest.guardian,manifest.keeper].map(a=>a.toLowerCase())).size===5);
  demand(typeof manifest.startBlock==='string'&&/^[1-9]\d*$/.test(manifest.startBlock));
  if(Object.hasOwn(manifest,'executionApproved'))demand(typeof manifest.executionApproved==='boolean');
  if(Object.hasOwn(manifest,'reviewDigest'))demand(hash(manifest.reviewDigest));
  const mode=env.ORACLE_RELAY_MODE??'observe';
  if(mode==='observe')demand(!env.ORACLE_RELAY_PRIVATE_KEY);
  // Operator authorization, not evidence that the referenced review took place.
  if(mode==='execute')demand(manifest.executionApproved===true&&hash(manifest.reviewDigest));
  demand(typeof env.ORACLE_STATUS_TOKEN==='string'&&env.ORACLE_STATUS_TOKEN.length>=32);
  const base=configFromEnv({
    NODE_ENV:env.NODE_ENV,PORT:env.PORT,ALCHEMY_RPC_URL:env.ORACLE_RPC_URL,
    KEEPER_FALLBACK_RPC_URLS:env.ORACLE_FALLBACK_RPC_URLS,
    KEEPER_MODE:mode,KEEPER_PRIVATE_KEY:env.ORACLE_RELAY_PRIVATE_KEY,
    KEEPER_VAULT_ADDRESS:API3_SERVER,KEEPER_VAULT_CODE_HASH:API3_SERVER_HASH,KEEPER_START_BLOCK:manifest.startBlock,
    KEEPER_DATA_DIR:env.ORACLE_DATA_DIR??'./data/api3-usdg-oracle',KEEPER_STATUS_TOKEN:env.ORACLE_STATUS_TOKEN,
    KEEPER_POLL_MS:env.ORACLE_POLL_MS??'5000',KEEPER_CONFIRMATIONS:env.ORACLE_CONFIRMATIONS??'2',
    KEEPER_RPC_TIMEOUT_MS:'5000',KEEPER_MAX_HEAD_AGE_SECONDS:'20',KEEPER_REPLACE_AFTER_MS:'10000',
    KEEPER_MIN_ETH:env.ORACLE_MIN_ETH,KEEPER_MAX_TX_FEE_ETH:env.ORACLE_MAX_TX_FEE_ETH,
    KEEPER_DAILY_GAS_ETH:env.ORACLE_DAILY_GAS_ETH,KEEPER_MAX_REPLACEMENTS:env.ORACLE_MAX_REPLACEMENTS,
    KEEPER_ALERT_WEBHOOK_URL:env.ORACLE_ALERT_WEBHOOK_URL,RESEND_API_KEY:env.RESEND_API_KEY,
    KEEPER_ALERT_EMAIL_FROM:env.ORACLE_ALERT_EMAIL_FROM,KEEPER_ALERT_EMAIL_TO:env.ORACLE_ALERT_EMAIL_TO,
    KEEPER_ALERT_REMINDER_MS:env.ORACLE_ALERT_REMINDER_MS,
  });
  demand(base.confirmations>=2n&&base.confirmations<=100n&&base.pollMs<=10000);
  if(base.alertWebhook)demand(new URL(base.alertWebhook).protocol==='https:');
  if(mode==='execute')demand(Boolean(base.alertWebhook||base.alertEmail));
  const identity={kind:manifest.kind,chainId:4663,server:API3_SERVER,serverCodeHash:API3_SERVER_HASH,
    sourceRevision:API3_SOURCE_REVISION,publication:p,relayAddress:manifest.relayAddress.toLowerCase()};
  const identityHash=keccak256('0x'+Buffer.from(JSON.stringify(identity)).toString('hex'));
  return {...base,publication:p,relayAddress:manifest.relayAddress,identity,identityHash,alertCheckMs:300000,cycleMaxAgeMs:30000};
}
