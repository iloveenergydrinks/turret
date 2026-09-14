import {describe,it,expect,vi} from 'vitest';
import {encodeFunctionData,zeroAddress} from 'viem';
import {SWAP_ROUTER,SWAP_TARGET,PAYMENT_TOKENS,swapAbi,validateSwapInput,validateSwapRoute,validateSwapTransaction,minimumReceived} from './collateral-swap.mjs';
import {assertSwapWallet,approveSwap,sendCollateralSwap} from './swap-wallet.mjs';
const account='0x1111111111111111111111111111111111111111',engine='0x2222222222222222222222222222222222222222',collateral='0x3333333333333333333333333333333333333333';
function fixture(payToken='USDG'){
 const now=Date.now(),input={engine,payToken,amountIn:'100000000',slippageBps:50},market={engine,collateral,chainId:4663,admission:'active',central:{}};
 const routeSummary={tokenIn:PAYMENT_TOKENS[payToken].address,tokenOut:collateral,amountIn:input.amountIn,amountOut:'500000000000000000',timestamp:Math.floor(now/1000),route:[[{exchange:'uniswapv3'}]]};
 const quote={id:'test',routeSummary,expiresAt:now+25000};
 const execution={callTarget:SWAP_TARGET,approveTarget:zeroAddress,targetData:'0x12345678',clientData:'0x',desc:{srcToken:routeSummary.tokenIn,dstToken:collateral,srcReceivers:[SWAP_TARGET],srcAmounts:[100000000n],feeReceivers:[],feeAmounts:[],dstReceiver:account,amount:100000000n,minReturnAmount:minimumReceived(routeSummary.amountOut,50),flags:512n,permit:'0x'}};
 if(payToken==='ETH'){execution.desc.srcReceivers=[];execution.desc.srcAmounts=[];}
 const built={quoteId:'test',account,chainId:4663,expiresAt:quote.expiresAt,transaction:{to:SWAP_ROUTER,data:encodeFunctionData({abi:swapAbi,functionName:'swap',args:[execution]}),value:payToken==='ETH'?input.amountIn:'0'}};
 return {now,input,market,quote,execution,built,encode(){built.transaction.data=encodeFunctionData({abi:swapAbi,functionName:'swap',args:[execution]});}};
}
describe('collateral swap trust boundary',()=>{
 it('accepts constrained USDG and native ETH calldata',()=>{for(const t of ['USDG','ETH']){const f=fixture(t);expect(validateSwapTransaction(f.built,f.quote,f.input,f.market,account,f.now)).toEqual(f.built.transaction);}});
 it('rejects unsupported or inactive markets, zero and overflow amounts',()=>{const f=fixture();expect(validateSwapInput(f.input,[f.market])).toBe(f.market);for(const amountIn of ['0','-1','1.5','1e18',(2n**256n).toString()])expect(()=>validateSwapInput({...f.input,amountIn},[f.market])).toThrow();expect(()=>validateSwapInput(f.input,[{...f.market,admission:'legacy'}])).toThrow();});
 it('rejects changed recipients, tokens, amounts, fees, spenders and arbitrary targets',()=>{
  const mutations=[(e:any)=>e.desc.dstReceiver=engine,(e:any)=>e.desc.srcToken=collateral,(e:any)=>e.desc.dstToken=engine,(e:any)=>e.desc.amount=1n,(e:any)=>e.desc.minReturnAmount=1n,(e:any)=>e.desc.flags=0n,(e:any)=>e.desc.permit='0xabcd',(e:any)=>e.approveTarget=engine,(e:any)=>e.callTarget=engine,(e:any)=>e.desc.srcReceivers=[engine],(e:any)=>e.desc.srcAmounts=[1n],(e:any)=>{e.desc.feeReceivers=[engine];e.desc.feeAmounts=[1n];}];
  for(const mutate of mutations){const f=fixture();mutate(f.execution);f.encode();expect(()=>validateSwapTransaction(f.built,f.quote,f.input,f.market,account,f.now)).toThrow();}
 });
 it('rejects value, chain, quote-id changes and appended calldata',()=>{for(const change of [(b:any)=>b.transaction.value='1',(b:any)=>b.chainId=1,(b:any)=>b.quoteId='other',(b:any)=>b.transaction.to=engine,(b:any)=>b.transaction.data+='00']){const f=fixture();change(f.built);expect(()=>validateSwapTransaction(f.built,f.quote,f.input,f.market,account,f.now)).toThrow();}});
 it('expires quotes and rejects nested unreviewed liquidity',()=>{const f=fixture();expect(()=>validateSwapRoute(f.quote.routeSummary,f.input,f.market,f.now+31000)).toThrow();f.quote.routeSummary.route[0][0].extra={fallback:{exchange:'brownfi-v3'}};expect(()=>validateSwapRoute(f.quote.routeSummary,f.input,f.market,f.now)).toThrow();});
 it('rounds minimum received down in integer token units',()=>expect(minimumReceived('101',50)).toBe(100n));
 it('rejects wallet account or chain changes before prompting',async()=>{for(const chain of ['0x1','0x1237']){const wallet={request:vi.fn(async({method})=>method==='eth_accounts'?[engine]:chain)};await expect(assertSwapWallet(wallet,account)).rejects.toThrow();}});
 it('fails before approval if the wallet changed',async()=>{const wallet={request:vi.fn(async({method})=>method==='eth_accounts'?[engine]:'0x1237'),writeContract:vi.fn()};await expect(approveSwap({client:{},wallet,account,amount:1n,assertCurrent:()=>{}})).rejects.toThrow();expect(wallet.writeContract).not.toHaveBeenCalled();});
 it('never sends an invalid swap to the wallet',async()=>{const f=fixture();f.built.transaction.value='12';const wallet={sendTransaction:vi.fn()};await expect(sendCollateralSwap({...f,client:{},wallet,account,assertCurrent:()=>{},ready:async()=>{}})).rejects.toThrow();expect(wallet.sendTransaction).not.toHaveBeenCalled();});
});
