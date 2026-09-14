// Read-only candidate probe. No signer, transaction broadcast, or market approval.
import {pathToFileURL} from 'node:url';
import {createPublicClient,http,keccak256,parseAbi} from './deps.mjs';
import {PYTH_VERIFIER,requestPrices,requestSymbols,parseEnvelope} from './pyth.mjs';
import {verifierAbi} from './abi.mjs';

export const CASHCAT_PAIR = Object.freeze({
  collateral: '0x020bfC650A365f8BB26819deAAbF3E21291018b4',
  usdg: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168',
  collateralFeedId: 3441, usdgFeedId: 232,
  collateralSymbol: 'Crypto.CASHCAT/USD', usdgSymbol: 'Crypto.USDG/USD',
  maxPriceAge: 60, maxPairSkew: 10, maxConfidenceBps: 100,
  collateralMinPublishers: 2, usdgMinPublishers: 3,
});
const decimalsAbi = parseAbi(['function decimals() view returns(uint8)']);
const fail = code => { throw new PreflightError(code); };
class PreflightError extends Error {
  constructor(code) { super(code); this.code = code; }
}
const abs = n => n < 0n ? -n : n;
const address = value => typeof value === 'string' && /^0x[\da-f]{40}$/i.test(value) && !/^0x0{40}$/i.test(value);

export function validatePolicy(p) {
  for (const [key,min,max] of [
    ['collateralFeedId',1,0xffffffff],['usdgFeedId',1,0xffffffff],
    ['maxPriceAge',1,60],['maxPairSkew',1,60],['maxConfidenceBps',1,1000],
    ['collateralMinPublishers',2,65535],['usdgMinPublishers',2,65535],
  ]) if (!Number.isInteger(p?.[key]) || p[key] < min || p[key] > max) fail('InvalidPolicy');
  if (p.collateralFeedId === p.usdgFeedId || p.maxPairSkew > p.maxPriceAge
    || !address(p.collateral) || !address(p.usdg) || p.collateral.toLowerCase() === p.usdg.toLowerCase()
    || typeof p.collateralSymbol!=='string' || typeof p.usdgSymbol!=='string'
    || !p.collateralSymbol || !p.usdgSymbol || p.collateralSymbol === p.usdgSymbol) fail('InvalidPolicy');
}

// Mirrors DockyardPythUsdRatioFeed. Inputs must come from parseEnvelope, not API JSON.
export function evaluatePair(feeds, nowSeconds, policy = CASHCAT_PAIR) {
  validatePolicy(policy);
  if (typeof nowSeconds !== 'bigint' || nowSeconds <= 0n) fail('InvalidClock');
  if (!Array.isArray(feeds) || feeds.length !== 2) fail('FeedMismatch');
  const a = feeds.find(f => f.id === policy.collateralFeedId);
  const b = feeds.find(f => f.id === policy.usdgFeedId);
  if (!a || !b) fail('FeedMismatch');
  const nowUs = nowSeconds * 1000000n, issues = [];
  for (const [f, minimum] of [[a,policy.collateralMinPublishers],[b,policy.usdgMinPublishers]]) {
    const add = code => issues.push({feedId:f.id,code});
    if (f.timestampUs <= 0n || f.timestampUs > nowUs || nowUs - f.timestampUs >= 30000000n) add('report_stale');
    if (f.sourceUs <= 0n || f.sourceUs > f.timestampUs
      || nowUs - f.sourceUs >= BigInt(policy.maxPriceAge) * 1000000n) add('price_stale');
    if (f.price <= 0n || f.confidence < 0n || f.confidence >= f.price
      || f.confidence * 10000n > f.price * BigInt(policy.maxConfidenceBps)
      || f.exponent < -18 || f.exponent > 0 || f.publishers < minimum) add('price_quality');
    if (f.session !== 0) add('non_regular_session');
  }
  if (abs(a.timestampUs-b.timestampUs) > BigInt(policy.maxPairSkew)*1000000n
    || abs(a.sourceUs-b.sourceUs) > BigInt(policy.maxPairSkew)*1000000n) issues.push({code:'pair_skew'});
  if (issues.length) return {available:false,issues};
  const numerator = (a.price-a.confidence)*10n**BigInt(18+a.exponent);
  const denominator = (b.price+b.confidence)*10n**BigInt(18+b.exponent);
  const answer = numerator*10n**18n/denominator;
  const oldest = a.sourceUs < b.sourceUs ? a.sourceUs : b.sourceUs;
  if (answer === 0n || answer > 2n**255n-1n || oldest/1000000n === 0n) {
    return {available:false,issues:[{code:'invalid_ratio'}]};
  }
  return {available:true,issues:[],answer,decimals:18,roundId:oldest,updatedAt:oldest/1000000n};
}

export function verifyMetadata(symbols, policy = CASHCAT_PAIR) {
  validatePolicy(policy);
  if (!Array.isArray(symbols)) fail('MetadataMismatch');
  return [[policy.collateralSymbol,policy.collateralFeedId,policy.collateralMinPublishers],
    [policy.usdgSymbol,policy.usdgFeedId,policy.usdgMinPublishers]].map(([symbol,id,minimum]) => {
    const matches = symbols.filter(s => s.symbol === symbol);
    if (matches.length !== 1) fail('MetadataMismatch');
    const m = matches[0];
    if (m.pyth_lazer_id !== id || m.state !== 'stable' || m.instrument_type !== 'spot' || m.asset_type !== 'crypto'
      || !Number.isInteger(m.exponent) || m.exponent < -18 || m.exponent > 0
      || !Number.isInteger(m.min_publishers) || m.min_publishers < 2 || m.min_publishers > minimum) fail('MetadataMismatch');
    return {symbol,id,exponent:m.exponent,minPublishers:m.min_publishers};
  });
}

export async function probePair({client,key,verifierCodeHash,caller,policy=CASHCAT_PAIR,
  getPrices=requestPrices,getSymbols=requestSymbols,now=()=>Date.now()}) {
  validatePolicy(policy);
  if (!key || !address(caller) || !/^0x[\da-f]{64}$/i.test(verifierCodeHash ?? '')) fail('InvalidConfiguration');
  if (await client.getChainId() !== 4663) fail('WrongChain');
  const metadata = verifyMetadata(await getSymbols(key),policy);
  const response = await getPrices(key,[policy.collateralFeedId,policy.usdgFeedId]);
  // Ignore any unsigned prices or caller-supplied decoded fields.
  const report = parseEnvelope(response.signed);
  if (report.feeds.length !== 2 || new Set(report.feeds.map(f=>f.id)).size !== 2
    || report.feeds.some(f=>![policy.collateralFeedId,policy.usdgFeedId].includes(f.id))) fail('FeedMismatch');
  if (report.feeds.some(f=>f.exponent !== metadata.find(m=>m.id===f.id)?.exponent)) fail('MetadataMismatch');
  const block = await client.getBlock();
  if (typeof block.number !== 'bigint' || !/^0x[\da-f]{64}$/i.test(block.hash ?? '')) fail('InvalidHead');
  const checkClock = () => {
    const ms = now();
    if (!Number.isSafeInteger(ms) || ms <= 0 || block.timestamp*1000n > BigInt(ms)
      || BigInt(ms)-block.timestamp*1000n >= 30000n) fail('StaleHead');
  };
  checkClock();
  const at = {blockNumber:block.number};
  const code = await client.getCode({address:PYTH_VERIFIER,...at});
  if (!code || code === '0x' || keccak256(code).toLowerCase() !== verifierCodeHash.toLowerCase()) fail('VerifierRuntimeMismatch');
  const tokens = [];
  for (const [token,expectedDecimals] of [[policy.collateral,18],[policy.usdg,6]]) {
    const runtime = await client.getCode({address:token,...at});
    if (!runtime || runtime === '0x') fail('MissingToken');
    const decimals = await client.readContract({address:token,abi:decimalsAbi,functionName:'decimals',...at});
    if (Number(decimals) !== expectedDecimals) fail('TokenDecimalsMismatch');
    tokens.push({address:token,decimals:Number(decimals),runtimeHash:keccak256(runtime)});
  }
  const fee = await client.readContract({address:PYTH_VERIFIER,abi:verifierAbi,functionName:'verification_fee',...at});
  if (typeof fee !== 'bigint' || fee < 0n || fee > 1000000000n) fail('VerificationFeeExceeded');
  const simulation = await client.simulateContract({address:PYTH_VERIFIER,abi:verifierAbi,
    functionName:'verifyUpdate',args:[response.signed],value:fee,account:caller,...at});
  if (simulation.result?.[0]?.toLowerCase() !== `0x${response.signed.slice(144)}`.toLowerCase()
    || !address(simulation.result?.[1])) fail('VerificationResultMismatch');
  const canonical = await client.getBlock({blockNumber:block.number});
  if (canonical.hash !== block.hash) fail('ReorgDetected');
  checkClock();
  const quote = evaluatePair(report.feeds,block.timestamp,policy);
  const currentQuote = evaluatePair(report.feeds,BigInt(Math.floor(now()/1000)),policy);
  return {kind:'isolated-pyth-read-only-preflight',productionChanged:false,marketApproved:false,
    exactTokenBindingReviewed:false,publisherIndependenceReviewed:false,
    chainId:4663,block:block.number,blockHash:block.hash,blockTimestamp:block.timestamp,
    verifier:PYTH_VERIFIER,verifierCodeHash,verificationFee:fee,signatureVerified:true,signer:simulation.result[1],
    metadata,tokens,policy,quote,currentQuote,reportTimestampUs:report.timestampUs,
    readyForAdapterTrial:quote.available && currentQuote.available,
    limitations:['No hub publication or running relay verified','No market approval or oracle independence established',
      'Does not fix primary TWAP liquidation delay','Verifier proxy upgrade authority remains a trust dependency']};
}

// Provider/RPC errors may embed credentials. Print only fixed, known error codes.
export function safePreflightError(error) {
  if (error instanceof PreflightError) return error.code;
  return ['PythEntitlementDenied','PythRateLimited','PythUnavailable','PythEnvelopeInvalid',
    'PythFeedMismatch','PythSymbolsUnavailable','PythSymbolsInvalid','InvalidPythConfiguration'].includes(error?.name)
    ? error.name : 'ReadOnlyProbeFailed';
}
export async function main(env=process.env) {
  try {
    if (!env.ALCHEMY_RPC_URL || !env.PYTH_API_KEY) fail('MissingCredentials');
    const client = createPublicClient({transport:http(env.ALCHEMY_RPC_URL,{timeout:15000,retryCount:1}),cacheTime:0});
    const result = await probePair({client,key:env.PYTH_API_KEY,
      verifierCodeHash:env.ISOLATED_PYTH_VERIFIER_CODE_HASH,caller:env.ISOLATED_PYTH_PREFLIGHT_CALLER});
    console.log(JSON.stringify(result,(_,v)=>typeof v==='bigint'?v.toString():v));
    return result.readyForAdapterTrial ? 0 : 2;
  } catch (error) {
    console.error(JSON.stringify({kind:'isolated-pyth-read-only-preflight',productionChanged:false,
      marketApproved:false,error:safePreflightError(error)}));
    return 1;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main();
