// Read-only: no wallet or signing key. API keys and RPC URLs are never logged.
import {readFileSync,writeFileSync} from 'node:fs';
import {createPublicClient,http,keccak256} from './deps.mjs';
import {PYTH_VERIFIER,requestPrices,requestSymbols,decodeEnvelope,parseEnvelope} from './pyth.mjs';
import {verifierAbi,stockAbi,chainlinkAbi} from './abi.mjs';
import {errorCode} from '../../liquidator/src/chain.mjs';
const root=new URL('../../../',import.meta.url);
try {
 const key=process.env.PYTH_API_KEY, rpc=process.env.ALCHEMY_RPC_URL;
 if(!key || !rpc)throw new Error('Missing preflight credentials');
 const client=createPublicClient({transport:http(rpc,{timeout:15000,retryCount:1}),cacheTime:0});
 if(await client.getChainId()!==4663)throw new Error('Wrong chain');
 const chainSnapshot=JSON.parse(readFileSync(new URL('docs/security/evidence/2026-09-02/mainnet-snapshot.json',root)));
 const symbols=await requestSymbols(key), markets=[];
 for(const market of chainSnapshot.markets){
  const symbol=`Equity.US.${market.symbol}/USD`, match=symbols.filter(x=>x.symbol===symbol);
  if(match.length!==1 || match[0].state!=='stable' || match[0].instrument_type!=='spot')throw new Error('Unsupported market metadata');
  const metadata=match[0];
  markets.push({symbol:market.symbol,collateral:market.address,primaryOracle:market.primaryOracle,feedId:metadata.pyth_lazer_id,
   metadata:{symbol,exponent:metadata.exponent,minPublishers:metadata.min_publishers,minChannel:metadata.min_channel,marketSessions:metadata.market_sessions,corporateActions:metadata.corporate_actions ?? []}});
 }
 const block=await client.getBlock(), code=await client.getCode({address:PYTH_VERIFIER,blockNumber:block.number});
 if(!code || code==='0x')throw new Error('Missing Pyth verifier');
 const fee=await client.readContract({address:PYTH_VERIFIER,abi:verifierAbi,functionName:'verification_fee',blockNumber:block.number});
 const evidence={capturedAt:new Date().toISOString(),chainId:4663,block:block.number.toString(),verifier:PYTH_VERIFIER,verifierCodeHash:keccak256(code),verificationFee:fee.toString(),markets};
 const sample=await requestPrices(key,[1]); // Tests the real signature path even when equity entitlement is absent.
 const simulation=await client.simulateContract({address:PYTH_VERIFIER,abi:verifierAbi,functionName:'verifyUpdate',args:[sample.signed],value:fee,
  account:'0x8D9c41c35a1Cf9A6958d58880d3DC5dca36f5086',blockNumber:block.number});
 evidence.cryptoSignatureVerified=true; evidence.sampleSigner=simulation.result[1];
 evidence.sample={signed:sample.signed,...parseEnvelope(sample.signed)};
 try {
  const prices=await requestPrices(key,markets.map(x=>x.feedId));evidence.equityAccess=true;evidence.equityReport=prices;
  await client.simulateContract({address:PYTH_VERIFIER,abi:verifierAbi,functionName:'verifyUpdate',args:[prices.signed],value:fee,
   account:'0x8D9c41c35a1Cf9A6958d58880d3DC5dca36f5086',blockNumber:block.number});
  evidence.equitySignatureVerified=true;
 } catch(error){evidence.equityAccess ??= false;evidence.equitySignatureVerified=false;evidence.equityAccessError=errorCode(error);}
 for(const market of markets){
  const read=(address,abi,functionName)=>client.readContract({address,abi,functionName,blockNumber:block.number});
  const [multiplier,effectiveAt,oraclePaused,round,decimals]=await Promise.all([
   read(market.collateral,stockAbi,'uiMultiplier'),read(market.collateral,stockAbi,'effectiveAt'),read(market.collateral,stockAbi,'oraclePaused'),
   read(market.primaryOracle,chainlinkAbi,'latestRoundData'),read(market.primaryOracle,chainlinkAbi,'decimals')]);
  market.onchain={multiplier,effectiveAt,oraclePaused,primaryAnswer:round[1],primaryTimestamp:round[3],primaryAge:block.timestamp-round[3],primaryDecimals:decimals};
 }
 const output=new URL('docs/security/evidence/2026-09-02/pyth-preflight.json',root);
 writeFileSync(output,JSON.stringify(evidence,(_,v)=>typeof v==='bigint'?v.toString():v,2)+'\n');
 console.log(JSON.stringify({block:evidence.block,verifierCodeHash:evidence.verifierCodeHash,signatureVerified:evidence.cryptoSignatureVerified,equityAccess:evidence.equityAccess,equityAccessError:evidence.equityAccessError,
  markets:markets.map(x=>({symbol:x.symbol,id:x.feedId,primaryAge:x.onchain.primaryAge.toString(),multiplier:x.onchain.multiplier.toString()})),output:output.pathname}));
 if(!evidence.equityAccess || !evidence.equitySignatureVerified)process.exitCode=2;
} catch(error){console.error(JSON.stringify({preflight:'failed',error:errorCode(error)}));process.exitCode=1;}
