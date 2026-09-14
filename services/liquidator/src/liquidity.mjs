import { incident } from './alerts.mjs';
import { USD, BPS } from './risk.mjs';

// Quotes are observability only. They never supply a destination, approval or transaction.
export async function checkLiquidity(market, price, config, previous) {
  if (!config.quoteUrl) return { checked:false, incidents:[incident(`liquidity_unknown:${market.address}`,'warning','No verified collateral sale quote is configured; collateral will be retained within the inventory budget.')] };
  if (previous && Date.now()-previous.checkedAt < 60000) return previous;
  try {
    const amountIn=config.quoteSize*10n**12n*USD/price;
    const headers={'Content-Type':'application/json'};
    if (config.quoteApiKey) headers.Authorization=`Bearer ${config.quoteApiKey}`;
    const response=await fetch(config.quoteUrl,{method:'POST',headers,signal:AbortSignal.timeout(8000),
      body:JSON.stringify({chainId:config.chainId,tokenIn:market.address,tokenOut:config.usdg,amountIn:amountIn.toString()})});
    if (!response.ok) throw new Error('Quote unavailable');
    const quote=await response.json();
    // Required adapter contract: raw token units, exact requested pair/size, fresh timestamp.
    if (quote.chainId !== config.chainId || quote.tokenIn?.toLowerCase() !== market.address
      || quote.tokenOut?.toLowerCase() !== config.usdg.toLowerCase() || quote.amountIn !== amountIn.toString()
      || !/^\d+$/.test(quote.amountOut) || !Number.isFinite(quote.timestamp)
      || Date.now()-quote.timestamp > 60000 || quote.timestamp > Date.now()+5000) throw new Error('Invalid quote');
    const output=BigInt(quote.amountOut), floor=config.quoteSize*(BPS-BigInt(config.maxQuoteSlippageBps))/BPS;
    return { checked:true, checkedAt:Date.now(), amountIn, amountOut:output, incidents:output < floor ? [incident(`liquidity_thin:${market.address}`,'critical','Collateral sale quote is below the configured depth/slippage threshold.',{expected:config.quoteSize,quoted:output})] : [] };
  } catch {
    return { checked:false, checkedAt:Date.now(), incidents:[incident(`liquidity_unavailable:${market.address}`,'critical','The configured collateral quote source is unavailable or returned invalid data.')] };
  }
}
