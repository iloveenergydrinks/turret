// Read-only access probe. Decoding is not signature verification or market approval.
import {createHash,createHmac} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {decodeAbiParameters,encodeAbiParameters} from './deps.mjs';

export const USDG_STREAM_ID='0x00032a5d7bd525026e8a09dd481e5d21db9e22671943727dc31b9408f577125f';
const endpoint='https://api.dataengine.chain.link';
const path=`/api/v1/reports/latest?feedID=${USDG_STREAM_ID}`;
class StreamsError extends Error {}
const fail=code=>{throw new StreamsError(code);};
const envelopeTypes=['bytes32[3]','bytes','bytes32[]','bytes32[]','bytes32'].map(type=>({type}));
const reportTypes=['bytes32','uint32','uint32','uint192','uint192','uint32','int192','int192','int192'].map(type=>({type}));

async function readBody(response) {
  const limit=65536;
  if(Number(response.headers.get('content-length'))>limit)fail('StreamsResponseTooLarge');
  const reader=response.body?.getReader();
  if(!reader)fail('StreamsReportInvalid');
  const chunks=[];let size=0;
  try {
    while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;
      if(size>limit)fail('StreamsResponseTooLarge');chunks.push(value);}
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally {await reader.cancel().catch(()=>{});}
}

function inspectReport(body,nowSeconds) {
  const full=body?.report?.fullReport;
  if(typeof full!=='string'||!/^0x(?:[0-9a-f]{2})+$/i.test(full))fail('StreamsReportInvalid');
  const envelope=decodeAbiParameters(envelopeTypes,full);
  if(encodeAbiParameters(envelopeTypes,envelope).toLowerCase()!==full.toLowerCase()
    ||envelope[2].length===0||envelope[2].length>31||envelope[2].length!==envelope[3].length)fail('StreamsReportInvalid');
  const data=decodeAbiParameters(reportTypes,envelope[1]);
  if(encodeAbiParameters(reportTypes,data).toLowerCase()!==envelope[1].toLowerCase())fail('StreamsReportInvalid');
  const [feedId,validFrom,observed,nativeFee,linkFee,expiresAt,price,bid,ask]=data;
  if(feedId.toLowerCase()!==USDG_STREAM_ID||body.report.feedID?.toLowerCase()!==USDG_STREAM_ID
    ||body.report.validFromTimestamp!==validFrom||body.report.observationsTimestamp!==observed)fail('StreamsFeedMismatch');
  const issues=[];
  if(validFrom<=0||validFrom>observed||observed>nowSeconds||nowSeconds-observed>=60
    ||expiresAt<=nowSeconds||expiresAt<observed)issues.push('report_time_invalid');
  if(price<=0n||bid<=0n||bid>price||ask<price||(ask-bid)*10000n>price*100n)issues.push('price_quality');
  return {kind:'stock-chainlink-usdg-access-probe',feedId,decimals:18,observed,validFrom,expiresAt,
    price,bid,ask,nativeFee,linkFee,ageSeconds:nowSeconds-observed,priceChecksPassed:issues.length===0,issues,
    signatureVerified:false,productionApproved:false,productionChanged:false};
}

export async function inspectChainlinkUsdg({key,secret,fetcher=fetch,now=Date.now}) {
  try {
    if(typeof key!=='string'||!key||typeof secret!=='string'||!secret)fail('StreamsCredentialsMissing');
    const timestamp=now();
    if(!Number.isSafeInteger(timestamp)||timestamp<=0)fail('StreamsClockInvalid');
    const hash=createHash('sha256').update('').digest('hex');
    const signature=createHmac('sha256',secret).update(`GET ${path} ${hash} ${key} ${timestamp}`).digest('hex');
    const response=await fetcher(endpoint+path,{method:'GET',redirect:'error',signal:AbortSignal.timeout(10000),
      headers:{Authorization:key,'X-Authorization-Timestamp':String(timestamp),'X-Authorization-Signature-SHA256':signature}});
    if(response.status===401||response.status===403)fail('StreamsAccessDenied');
    if(response.status===429)fail('StreamsRateLimited');
    if(response.status!==200)fail('StreamsUnavailable');
    const body=await readBody(response),finished=now();
    if(!Number.isSafeInteger(finished)||finished<timestamp)fail('StreamsClockInvalid');
    return inspectReport(body,Math.floor(finished/1000));
  } catch(error) {
    if(error instanceof StreamsError)throw error;
    fail('StreamsProbeFailed');
  }
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) {
  try {
    const result=await inspectChainlinkUsdg({key:process.env.STREAMS_API_KEY,secret:process.env.STREAMS_API_SECRET});
    console.log(JSON.stringify(result,(_,value)=>typeof value==='bigint'?value.toString():value));
    // Even a fresh decoded report is not an approved production oracle.
    process.exitCode=2;
  } catch(error) {
    console.error(JSON.stringify({probe:'failed',error:error instanceof StreamsError?error.message:'StreamsProbeFailed',productionChanged:false}));
    process.exitCode=1;
  }
}
