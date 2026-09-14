import {configFromEnv} from '../../liquidator/src/config.mjs';
import {validatePolicy,CASHCAT_PAIR} from './isolated-pyth-preflight.mjs';
import {keccak256} from './deps.mjs';

const address=x=>typeof x==='string'&&/^0x[\da-f]{40}$/i.test(x)&&!/^0x0{40}$/i.test(x);
const hash=x=>typeof x==='string'&&/^0x[\da-f]{64}$/i.test(x)&&!/^0x0{64}$/i.test(x);
const demand=(ok)=>{if(!ok)throw Error('Invalid isolated oracle configuration');};
const PONS='0x39dbed3a2bd333467115de45665cc57f813c4571';
const fields=(value,required,optional=[])=>demand(value&&typeof value==='object'&&!Array.isArray(value)
  &&required.every(k=>Object.hasOwn(value,k))&&Object.keys(value).every(k=>required.includes(k)||optional.includes(k)));

// No stock-vault defaults, inherited keeper signer, or inferred PONS feed ID.
export function isolatedConfigFromEnv(env,manifest) {
  fields(manifest,['kind','chainId','startBlock','publication','relayAddress','guardian','keeper'],['executionApproved','reviewDigest']);
  demand(manifest?.kind==='isolated-pyth-ratio'&&manifest.chainId===4663);
  if(Object.hasOwn(manifest,'executionApproved'))demand(typeof manifest.executionApproved==='boolean');
  if(Object.hasOwn(manifest,'reviewDigest'))demand(hash(manifest.reviewDigest));
  const p=manifest.publication;
  fields(p,['policy','hub','adapter','hubCodeHash','adapterCodeHash','verifierCodeHash','collateralCodeHash','usdgCodeHash']);
  fields(p.policy,Object.keys(CASHCAT_PAIR));
  validatePolicy(p?.policy);
  demand(p.policy.usdg.toLowerCase()===CASHCAT_PAIR.usdg.toLowerCase()
    &&[CASHCAT_PAIR.collateral.toLowerCase(),PONS].includes(p.policy.collateral.toLowerCase()));
  demand([p.hub,p.adapter,manifest.relayAddress,manifest.guardian,manifest.keeper].every(address));
  demand(new Set([p.hub,p.adapter,manifest.relayAddress,manifest.guardian,manifest.keeper].map(x=>x.toLowerCase())).size===5);
  demand(['hubCodeHash','adapterCodeHash','verifierCodeHash','collateralCodeHash','usdgCodeHash'].every(k=>hash(p[k])));
  demand(typeof manifest.startBlock==='string'&&/^[1-9]\d*$/.test(manifest.startBlock));
  demand(typeof env.ORACLE_STATUS_TOKEN==='string'&&env.ORACLE_STATUS_TOKEN.length>=32);
  demand(typeof env.PYTH_API_KEY==='string'&&env.PYTH_API_KEY.length>0);
  const mode=env.ORACLE_RELAY_MODE??'observe';
  // This flag is an operator authorization, not evidence that a review occurred.
  if(mode==='execute')demand(manifest.executionApproved===true&&hash(manifest.reviewDigest));
  if(mode==='observe')demand(!env.ORACLE_RELAY_PRIVATE_KEY);
  const valueBudget=env.ORACLE_DAILY_VERIFICATION_FEE_WEI??'20000000000000';
  demand(typeof valueBudget==='string'&&/^[1-9]\d{0,17}$/.test(valueBudget));
  const base=configFromEnv({
    NODE_ENV:env.NODE_ENV,PORT:env.PORT,ALCHEMY_RPC_URL:env.ORACLE_RPC_URL,
    KEEPER_FALLBACK_RPC_URLS:env.ORACLE_FALLBACK_RPC_URLS,
    KEEPER_MODE:mode,KEEPER_PRIVATE_KEY:env.ORACLE_RELAY_PRIVATE_KEY,
    KEEPER_VAULT_ADDRESS:p.hub,KEEPER_START_BLOCK:manifest.startBlock,KEEPER_VAULT_CODE_HASH:p.hubCodeHash,
    KEEPER_DATA_DIR:env.ORACLE_DATA_DIR??'./data/isolated-oracle',KEEPER_STATUS_TOKEN:env.ORACLE_STATUS_TOKEN,
    KEEPER_POLL_MS:env.ORACLE_POLL_MS??'5000',KEEPER_CONFIRMATIONS:env.ORACLE_CONFIRMATIONS??'2',
    KEEPER_RPC_TIMEOUT_MS:'5000',KEEPER_MAX_HEAD_AGE_SECONDS:'20',KEEPER_REPLACE_AFTER_MS:'10000',
    KEEPER_MIN_ETH:env.ORACLE_MIN_ETH,KEEPER_MAX_TX_FEE_ETH:env.ORACLE_MAX_TX_FEE_ETH,
    KEEPER_DAILY_GAS_ETH:env.ORACLE_DAILY_GAS_ETH,KEEPER_MAX_REPLACEMENTS:env.ORACLE_MAX_REPLACEMENTS,
    KEEPER_ALERT_WEBHOOK_URL:env.ORACLE_ALERT_WEBHOOK_URL,RESEND_API_KEY:env.RESEND_API_KEY,
    KEEPER_ALERT_EMAIL_FROM:env.ORACLE_ALERT_EMAIL_FROM,KEEPER_ALERT_EMAIL_TO:env.ORACLE_ALERT_EMAIL_TO,
    KEEPER_ALERT_REMINDER_MS:env.ORACLE_ALERT_REMINDER_MS,
  });
  demand(base.confirmations>=2n&&base.pollMs<=10000);
  if(base.alertWebhook)demand(new URL(base.alertWebhook).protocol==='https:');
  if(mode==='execute')demand(Boolean(base.alertWebhook||base.alertEmail));
  const identity={kind:manifest.kind,chainId:4663,publication:p,relayAddress:manifest.relayAddress.toLowerCase()};
  const identityHash=keccak256('0x'+Buffer.from(JSON.stringify(identity)).toString('hex'));
  return {...base,maxDailyVerificationValue:BigInt(valueBudget),publication:p,relayAddress:manifest.relayAddress,key:env.PYTH_API_KEY,
    identity,identityHash,
    alertCheckMs:300000,cycleMaxAgeMs:30000};
}
