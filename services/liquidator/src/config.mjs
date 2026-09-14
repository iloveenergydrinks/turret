import { getAddress, parseEther, parseUnits, zeroAddress } from 'viem';

export const PRODUCTION = Object.freeze({
  chainId: 4663,
  vault: '0x576c510e9A268B06448f67598B7BF1ed33388e20',
  usdg: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168',
  startBlock: 52112699n,
});
export function configFromEnv(env = process.env) {
  const integer = (name, defaultValue, min = 1, max = Number.MAX_SAFE_INTEGER) => {
    const value = Number(env[name] ?? defaultValue);
    if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`Invalid ${name}`);
    return value;
  };
  const usd = (name, defaultValue) => {
    const value = parseUnits(env[name] ?? defaultValue, 6);
    if (value <= 0n) throw new Error(`Invalid ${name}`);
    return value;
  };
  const eth = (name, defaultValue) => {
    const value = parseEther(env[name] ?? defaultValue);
    if (value <= 0n) throw new Error(`Invalid ${name}`);
    return value;
  };
  // V2 uses a separate deployment and discovery cursor; never infer one from the other.
  const overrideVault = env.KEEPER_VAULT_ADDRESS;
  const overrideStart = env.KEEPER_START_BLOCK;
  if (Boolean(overrideVault) !== Boolean(overrideStart)) throw new Error('Vault override requires its deployment start block');
  const deployment = overrideVault ? {
    ...PRODUCTION, vault: getAddress(overrideVault), startBlock: BigInt(integer('KEEPER_START_BLOCK', undefined, 1)),
  } : PRODUCTION;
  const mode = env.KEEPER_MODE ?? 'observe';
  if (!['observe', 'execute'].includes(mode)) throw new Error('Invalid KEEPER_MODE');
  const rpcUrl = env.ALCHEMY_RPC_URL ?? env.KEEPER_RPC_URL;
  if (!rpcUrl) throw new Error('ALCHEMY_RPC_URL or KEEPER_RPC_URL required');
  const rpcUrls = [rpcUrl, ...(env.KEEPER_FALLBACK_RPC_URLS ?? '').split(',').filter(Boolean)];
  for (const url of rpcUrls) {
    if (!['https:', 'http:'].includes(new URL(url).protocol)) throw new Error('Invalid RPC URL');
  }
  if(env.KEEPER_FALLBACK_RPC_MAX_RPS!==undefined&&!/^\d+$/.test(String(env.KEEPER_FALLBACK_RPC_MAX_RPS)))
    throw new Error('Invalid KEEPER_FALLBACK_RPC_MAX_RPS');
  const privateKey = env.KEEPER_PRIVATE_KEY;
  if (privateKey && !/^0x[0-9a-fA-F]{64}$/.test(privateKey)) throw new Error('Invalid KEEPER_PRIVATE_KEY');
  // Retire a signer without losing the account-bound receipt journal. This is
  // deliberately mutually exclusive with both a key and execution mode.
  const observerAddress=env.KEEPER_OBSERVER_ADDRESS?getAddress(env.KEEPER_OBSERVER_ADDRESS):undefined;
  if(observerAddress&&(observerAddress===zeroAddress||privateKey||mode!=='observe'))throw new Error('Observer address requires keyless observe mode');
  const codeHash = env.KEEPER_VAULT_CODE_HASH;
  if (codeHash && !/^0x[0-9a-fA-F]{64}$/.test(codeHash)) throw new Error('Invalid KEEPER_VAULT_CODE_HASH');
  if (mode === 'execute' && (!privateKey || !codeHash)) throw new Error('Execution requires a dedicated signer and pinned vault code hash');
  const statusToken = env.KEEPER_STATUS_TOKEN;
  const alertLabel=(env.KEEPER_ALERT_LABEL??'').trim();
  if(alertLabel&&!/^[a-zA-Z0-9 ._-]{1,48}$/.test(alertLabel))throw new Error('Invalid KEEPER_ALERT_LABEL');
  const collateralPolicy=env.KEEPER_COLLATERAL_POLICY??'quote-required';
  if(!['quote-required','bounded-hold'].includes(collateralPolicy))throw new Error('Invalid collateral policy');
  const executionGate=env.KEEPER_EXECUTION_GATE?getAddress(env.KEEPER_EXECUTION_GATE):undefined;
  const livenessUrl=env.KEEPER_LIVENESS_URL;
  if(Boolean(executionGate)!==Boolean(livenessUrl))throw new Error('Execution gate requires its liveness endpoint');
  if(livenessUrl){const u=new URL(livenessUrl);if(u.protocol!=='https:'&&!['localhost','127.0.0.1'].includes(u.hostname))throw new Error('Invalid liveness endpoint');}
  if (env.NODE_ENV === 'production' && (!statusToken || statusToken.length < 32)) throw new Error('Production requires KEEPER_STATUS_TOKEN');
  return {
    ...deployment, mode, privateKey, observerAddress, codeHash, rpcUrls, statusToken,collateralPolicy,executionGate,livenessUrl,
    dataDir: env.KEEPER_DATA_DIR ?? './data', port: integer('PORT', 8080, 1, 65535),
    pollMs: integer('KEEPER_POLL_MS', 5000, 1000),
    deploymentVerifyIntervalMs: integer('KEEPER_DEPLOYMENT_VERIFY_INTERVAL_MS', 60000, 1000, 3600000),
    rpcTimeoutMs: integer('KEEPER_RPC_TIMEOUT_MS', 12000, 1000),
    fallbackRpcMaxRps: integer('KEEPER_FALLBACK_RPC_MAX_RPS', 0, 0, 1000),
    logChunk: BigInt(integer('KEEPER_LOG_CHUNK', 10000, 1, 100000)),
    maxChunksPerCycle: integer('KEEPER_BACKFILL_CHUNKS', 40, 1, 500),
    confirmations: BigInt(integer('KEEPER_CONFIRMATIONS', 12, 1)),
    maxHeadAgeSeconds: integer('KEEPER_MAX_HEAD_AGE_SECONDS', 60, 10),
    maxProviderLagBlocks: BigInt(integer('KEEPER_MAX_PROVIDER_LAG_BLOCKS', 40, 1)),
    heartbeatMaxAgeMs: integer('KEEPER_HEARTBEAT_MAX_AGE_MS', 180000, 30000),
    maxRepay: usd('KEEPER_MAX_REPAY_USDG', '50'),
    dailyBudget: usd('KEEPER_DAILY_BUDGET_USDG', '100'),
    // Cost basis of retained collateral. No credit for unverified sale proceeds.
    inventoryBudget: usd('KEEPER_INVENTORY_BUDGET_USDG', '100'),
    minUsdg: usd('KEEPER_MIN_USDG', '55'),
    minEth: eth('KEEPER_MIN_ETH', '0.001'),
    maxTxFee: eth('KEEPER_MAX_TX_FEE_ETH', '0.0005'),
    maxDailyGas: eth('KEEPER_DAILY_GAS_ETH', '0.003'),
    replaceAfterMs: integer('KEEPER_REPLACE_AFTER_MS', 60000, 10000),
    maxReplacements: integer('KEEPER_MAX_REPLACEMENTS', 3, 0, 10),
    alertWebhook: env.KEEPER_ALERT_WEBHOOK_URL,
    alertEmail: env.RESEND_API_KEY && env.KEEPER_ALERT_EMAIL_FROM && env.KEEPER_ALERT_EMAIL_TO ? {
      apiKey:env.RESEND_API_KEY,from:env.KEEPER_ALERT_EMAIL_FROM,to:env.KEEPER_ALERT_EMAIL_TO,
    } : undefined,
    nativeWatchdog: env.KEEPER_NATIVE_WATCHDOG === 'true',
    alertLabel:alertLabel||undefined,
    // Price simulations and full scans fail closed immediately. Email only if
    // these commonly transient failures remain active beyond this window.
    alertDebounceMs: integer('KEEPER_ALERT_DEBOUNCE_MS', 30000, 0, 600000),
    // Zero sends an initial incident/escalation only. Recovery and a persistent
    // outage remain visible in status without periodic inbox reminders.
    alertReminderMs: integer('KEEPER_ALERT_REMINDER_MS', 0, 0),
    // Optional read-only quote service. Never accepts transaction calldata from it.
    quoteUrl: env.KEEPER_LIQUIDITY_QUOTE_URL,
    quoteApiKey: env.KEEPER_LIQUIDITY_QUOTE_API_KEY,
    maxQuoteSlippageBps: integer('KEEPER_MAX_QUOTE_SLIPPAGE_BPS', 300, 0, 10000),
    quoteSize: usd('KEEPER_QUOTE_SIZE_USDG', '50'),
    collateralRecipient: env.KEEPER_COLLATERAL_RECIPIENT ? getAddress(env.KEEPER_COLLATERAL_RECIPIENT) : undefined,
  };
}
