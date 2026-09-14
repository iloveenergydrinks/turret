import {decodeFunctionData,encodeFunctionData,isAddress,parseAbi,zeroAddress} from 'viem';

export const SWAP_CHAIN = 4663;
export const SWAP_ROUTER = '0x6131B5fae19EA4f9D964eAc0408E4408b66337b5';
export const SWAP_TARGET = '0x8F10B468b06c6FD214B65F87778827F7D113f996';
export const SWAP_CODE = {
  [SWAP_ROUTER]: '0xdc6eb20a6d4701d8f0f04f9a3342d254eb2698bbad281d8578d6efba21865867',
  [SWAP_TARGET]: '0xfc8bfd5c118d0c06e9ff71b223fc3ba9612ac167edbf7e7e6e22bec156a5e70d',
};
export const PAYMENT_TOKENS = Object.freeze({
  USDG: {address:'0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168',decimals:6},
  ETH: {address:'0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE',decimals:18},
});
export const SWAP_SOURCES = ['uniswapv3','uniswap-v4','uniswap-v4-fee','ramses-v3','alandale-v4','orvex-cl-feemanager'];
export const swapAbi = parseAbi(['function swap((address callTarget,address approveTarget,bytes targetData,(address srcToken,address dstToken,address[] srcReceivers,uint256[] srcAmounts,address[] feeReceivers,uint256[] feeAmounts,address dstReceiver,uint256 amount,uint256 minReturnAmount,uint256 flags,bytes permit) desc,bytes clientData) execution) payable returns(uint256 returnAmount,uint256 gasUsed)']);
export const sameAddress=(a,b)=>typeof a==='string'&&typeof b==='string'&&a.toLowerCase()===b.toLowerCase();
export function swapNeed(ok,message='The swap details could not be verified. Refresh the quote.') {if(!ok)throw Error(message);}
export const uint=(x)=>typeof x==='string'&&/^[1-9][0-9]{0,77}$/.test(x)&&BigInt(x)<2n**256n;
export function validateSwapInput(input,markets) {
  swapNeed(input&&['USDG','ETH'].includes(input.payToken)&&uint(input.amountIn),'Enter a valid payment amount.');
  swapNeed([10,50,100].includes(input.slippageBps),'Choose a supported slippage tolerance.');
  const market=markets.find(m=>sameAddress(m.engine,input.engine)&&m.admission==='active'&&m.chainId===SWAP_CHAIN&&m.central);
  swapNeed(market&&isAddress(market.collateral)&&!sameAddress(market.collateral,PAYMENT_TOKENS[input.payToken].address),'This collateral market is unavailable.');
  return market;
}
export function validateSwapRoute(summary,input,market,now=Date.now()) {
  swapNeed(summary&&sameAddress(summary.tokenIn,PAYMENT_TOKENS[input.payToken].address)&&sameAddress(summary.tokenOut,market.collateral)
    &&summary.amountIn===input.amountIn&&uint(summary.amountOut));
  swapNeed(Number.isSafeInteger(summary.timestamp)&&summary.timestamp*1000<=now+1000&&now-summary.timestamp*1000<30000,'This quote expired. Refresh the quote.');
  swapNeed(Array.isArray(summary.route)&&summary.route.length>0&&summary.route.length<=32);
  let nodes=0,sources=0;
  function visit(value,depth=0) {
    swapNeed(depth<25&&++nodes<12000);
    if(value&&typeof value==='object'){
      if(Object.hasOwn(value,'exchange')) {swapNeed(SWAP_SOURCES.includes(value.exchange),'This route is not supported. Try a different amount.');sources++;}
      for(const value2 of Object.values(value))visit(value2,depth+1);
    }
  }
  visit(summary.route);swapNeed(sources>0);
  swapNeed(!summary.extraFee||['','0'].includes(String(summary.extraFee.feeAmount??''))&&['',zeroAddress].includes(summary.extraFee.feeReceiver??''));
  return summary;
}
export function minimumReceived(amountOut,slippageBps){return BigInt(amountOut)*BigInt(10000-slippageBps)/10000n;}
export function validateSwapTransaction(built,quote,input,market,account,now=Date.now()) {
  swapNeed(isAddress(account)&&!sameAddress(account,zeroAddress));
  validateSwapRoute(quote.routeSummary,input,market,now);
  swapNeed(quote.id===built.quoteId&&quote.expiresAt>now&&built.expiresAt===quote.expiresAt,'This quote expired. Refresh the quote.');
  const tx=built.transaction;
  swapNeed(tx&&sameAddress(tx.to,SWAP_ROUTER)&&sameAddress(built.account,account)&&built.chainId===SWAP_CHAIN);
  swapNeed(typeof tx.data==='string'&&/^0x(?:[a-f0-9]{2}){4,65536}$/i.test(tx.data));
  swapNeed(tx.value===(input.payToken==='ETH'?input.amountIn:'0'));
  const decoded=decodeFunctionData({abi:swapAbi,data:tx.data});
  swapNeed(decoded.functionName==='swap'&&encodeFunctionData({abi:swapAbi,...decoded}).toLowerCase()===tx.data.toLowerCase());
  const e=decoded.args[0],d=e.desc,amount=BigInt(input.amountIn),minimum=minimumReceived(quote.routeSummary.amountOut,input.slippageBps);
  swapNeed(sameAddress(e.callTarget,SWAP_TARGET)&&sameAddress(e.approveTarget,zeroAddress)&&/^0x(?:[a-f0-9]{2}){4,65536}$/i.test(e.targetData));
  swapNeed(/^0x(?:[a-f0-9]{2}){0,4096}$/i.test(e.clientData));
  swapNeed(sameAddress(d.srcToken,PAYMENT_TOKENS[input.payToken].address)&&sameAddress(d.dstToken,market.collateral)&&sameAddress(d.dstReceiver,account)
    &&d.amount===amount&&d.minReturnAmount>=minimum&&d.minReturnAmount<=BigInt(quote.routeSummary.amountOut)&&minimum>0n
    &&d.flags===512n&&d.permit==='0x'&&d.feeReceivers.length===0&&d.feeAmounts.length===0
    &&(input.payToken==='ETH'
      ?d.srcReceivers.length===0&&d.srcAmounts.length===0
      :d.srcReceivers.length>0&&d.srcReceivers.length<=32&&d.srcAmounts.length===d.srcReceivers.length
        &&d.srcReceivers.every(x=>sameAddress(x,SWAP_TARGET))&&d.srcAmounts.every(x=>x>0n)&&d.srcAmounts.reduce((a,b)=>a+b,0n)===amount));
  return tx;
}
