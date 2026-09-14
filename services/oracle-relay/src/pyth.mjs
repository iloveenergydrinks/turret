export const PYTH_VERIFIER = '0xACeA761c27A909d4D3895128EBe6370FDE2dF481';
export const PROPERTIES = ['price','publisherCount','exponent','confidence','marketSession','feedUpdateTimestamp'];
export class PythError extends Error {
  constructor(code) { super(code); this.name = code; }
}
const headers = key => ({Authorization:`Bearer ${key}`,'Content-Type':'application/json','User-Agent':'DockyardOracleIntegration/1.0'});
export async function requestPrices(key, ids, fetcher = fetch) {
  if (!key || !ids.length || ids.length > 32 || new Set(ids).size !== ids.length || ids.some(id=>!Number.isSafeInteger(id)||id<1)) throw new PythError('InvalidPythConfiguration');
  const response = await fetcher('https://pyth-lazer.dourolabs.app/v1/latest_price', {
    method:'POST', headers:headers(key), redirect:'error', signal:AbortSignal.timeout(10000),
    body:JSON.stringify({priceFeedIds:ids,properties:PROPERTIES,formats:['evm'],channel:'fixed_rate@1000ms'}),
  });
  if (response.status === 401 || response.status === 403) throw new PythError('PythEntitlementDenied');
  if (response.status === 429) throw new PythError('PythRateLimited');
  if (!response.ok) throw new PythError('PythUnavailable');
  const body = await response.json();
  const signed = decodeEnvelope(body.evm);
  // Decode the signed bytes, not the unauthenticated `parsed` JSON used by dashboards.
  const report = parseEnvelope(signed);
  const returned = report.feeds.map(x=>x.id);
  if (returned.length !== ids.length || returned.some(id=>!ids.includes(id)) || new Set(returned).size !== ids.length) throw new PythError('PythFeedMismatch');
  return {signed,...report};
}
export async function requestSymbols(key, fetcher = fetch) {
  const response = await fetcher('https://pyth.dourolabs.app/v1/symbols',{headers:headers(key),redirect:'error',signal:AbortSignal.timeout(15000)});
  if (!response.ok) throw new PythError('PythSymbolsUnavailable');
  const body = await response.json();
  if (!Array.isArray(body)) throw new PythError('PythSymbolsInvalid');
  return body;
}
export function decodeEnvelope(evm) {
  if (!evm || typeof evm.data !== 'string' || evm.data.length > 40000) throw new PythError('PythEnvelopeInvalid');
  let raw;
  if (evm.encoding === 'base64' && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(evm.data)) raw = Buffer.from(evm.data,'base64');
  else if (evm.encoding === 'hex' && /^(0x)?(?:[\da-fA-F]{2})+$/.test(evm.data)) raw = Buffer.from(evm.data.replace(/^0x/,''),'hex');
  else throw new PythError('PythEnvelopeInvalid');
  return `0x${raw.toString('hex')}`;
}
export function parseEnvelope(hex) {
  const raw = Buffer.from(hex.slice(2),'hex');
  const fail = () => { throw new PythError('PythEnvelopeInvalid'); };
  if (raw.length < 85 || raw.readUInt32BE(0) !== 706910618 || raw.readUInt16BE(69) + 71 !== raw.length) fail();
  const data=raw.subarray(71);
  if(data.readUInt32BE(0)!==2479346549 || data[12]<1 || data[12]>4 || data[13]<1 || data[13]>32) fail();
  const timestampUs=data.readBigUInt64BE(4), feeds=[]; let cursor=14;
  function take(n) { if(cursor+n>data.length)fail();const bytes=data.subarray(cursor,cursor+n);cursor+=n;return bytes; }
  for(let i=0;i<data[13];i++) {
    const id=take(4).readUInt32BE(), count=take(1)[0], feed={id,timestampUs}; const seen=new Set();
    if(count!==6 || !id)fail();
    for(let j=0;j<count;j++) {
      const tag=take(1)[0]; if(seen.has(tag))fail();seen.add(tag);
      if(tag===0)feed.price=take(8).readBigInt64BE();
      else if(tag===3)feed.publishers=take(2).readUInt16BE();
      else if(tag===4)feed.exponent=take(2).readInt16BE();
      else if(tag===5)feed.confidence=take(8).readBigUInt64BE();
      else if(tag===9)feed.session=take(2).readUInt16BE();
      else if(tag===12) { const present=take(1)[0]; if(present>1)fail();feed.sourceUs=present?take(8).readBigUInt64BE():0n; }
      else fail();
    }
    if(feed.session>4 || feed.sourceUs>timestampUs)fail();
    feeds.push(feed);
  }
  if(cursor!==data.length)fail();
  return {timestampUs,feeds};
}
export function priceIssues(feed, nowMs = Date.now()) {
  const nowUs=BigInt(nowMs)*1000n, issues=[];
  if (feed.timestampUs > nowUs || nowUs-feed.timestampUs >= 30_000_000n) issues.push('report_stale');
  if (feed.sourceUs === 0n || feed.sourceUs > nowUs || nowUs-feed.sourceUs >= 60_000_000n) issues.push('price_stale');
  if (feed.session === 4) issues.push('market_closed');
  if (feed.price<=0n || feed.confidence<=0n || feed.confidence*10000n>feed.price*100n || feed.publishers<2 || feed.exponent < -18 || feed.exponent > 0) issues.push('price_quality');
  return issues;
}
