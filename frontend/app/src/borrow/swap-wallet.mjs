import {erc20Abi,keccak256} from 'viem';
import {PAYMENT_TOKENS,SWAP_ROUTER,SWAP_CODE,SWAP_CHAIN,sameAddress,swapNeed,validateSwapTransaction} from './collateral-swap.mjs';

export async function assertSwapWallet(wallet,account) {
  const [accounts,chain]=await Promise.all([wallet.request({method:'eth_accounts'}),wallet.request({method:'eth_chainId'})]);
  swapNeed(sameAddress(accounts?.[0],account)&&Number(chain)===SWAP_CHAIN,'The connected wallet changed. Review the swap again.');
}
export async function verifySwapCode(client) {
  swapNeed(await client.getChainId()===SWAP_CHAIN);
  await Promise.all(Object.entries(SWAP_CODE).map(async([address,hash])=>{
    const code=await client.getCode({address});swapNeed(code&&keccak256(code)===hash,'The swap router needs verification. Swapping is unavailable.');
  }));
}
export async function paymentBalance(client,account,payToken) {
  return payToken==='ETH'?client.getBalance({address:account}):client.readContract({address:PAYMENT_TOKENS.USDG.address,abi:erc20Abi,functionName:'balanceOf',args:[account]});
}
export async function paymentAllowance(client,account,payToken) {
  return payToken==='ETH'?2n**256n-1n:client.readContract({address:PAYMENT_TOKENS.USDG.address,abi:erc20Abi,functionName:'allowance',args:[account,SWAP_ROUTER]});
}
export async function approveSwap({client,wallet,account,amount,assertCurrent}) {
  await assertSwapWallet(wallet,account);await verifySwapCode(client);
  swapNeed(await paymentBalance(client,account,'USDG')>=amount,'The USDG amount exceeds your wallet balance.');
  const p={address:PAYMENT_TOKENS.USDG.address,abi:erc20Abi,functionName:'approve',args:[SWAP_ROUTER,amount],account};
  const {request}=await client.simulateContract(p);
  await assertSwapWallet(wallet,account);assertCurrent();
  return wallet.writeContract({...request,account,chain:wallet.chain});
}
export async function sendCollateralSwap({client,wallet,account,input,market,quote,built,assertCurrent,ready}) {
  validateSwapTransaction(built,quote,input,market,account);
  await assertSwapWallet(wallet,account);
  await Promise.all([verifySwapCode(client),ready()]);
  const amount=BigInt(input.amountIn);
  const [balance,allowance,gasPrice]=await Promise.all([paymentBalance(client,account,input.payToken),paymentAllowance(client,account,input.payToken),client.getGasPrice()]);
  swapNeed(balance>=amount,'The amount exceeds your wallet balance.');
  swapNeed(allowance>=amount,'Approve USDG before swapping.');
  const tx={account,to:built.transaction.to,data:built.transaction.data,value:BigInt(built.transaction.value)};
  const estimatedGas=await client.estimateGas(tx); // Reverts fail before the wallet prompt.
  const gas=estimatedGas*120n/100n;
  const nativeBalance=input.payToken==='ETH'?balance:await client.getBalance({address:account});
  swapNeed(nativeBalance>=tx.value+gas*gasPrice*2n,'Keep enough ETH in your wallet for the network fee.');
  await assertSwapWallet(wallet,account);assertCurrent();
  validateSwapTransaction(built,quote,input,market,account);
  return wallet.sendTransaction({...tx,gas,chain:wallet.chain});
}
