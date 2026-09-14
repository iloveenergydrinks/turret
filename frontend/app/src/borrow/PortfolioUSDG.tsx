"use client";
import {useAccount,useReadContract} from 'wagmi';
import {erc20Abi,formatUnits} from 'viem';
import {USDGSwap} from './USDGSwap';
import {SWAP_USDG} from './usdg-swap';
export function PortfolioUSDG(){
 const {address,chainId}=useAccount();
 const balance=useReadContract({address:SWAP_USDG,abi:erc20Abi,functionName:'balanceOf',args:address?[address]:undefined,chainId:4663,query:{enabled:!!address&&chainId===4663,refetchInterval:20000,refetchOnWindowFocus:true}});
 if(!address||chainId!==4663)return null;
 const value=balance.isError?undefined:balance.data;
 return <section className="turret-portfolio-wallet" aria-label="Wallet USDG"><span>USDG in your wallet <strong>{value===undefined?'—':Number(formatUnits(value,6)).toLocaleString('en-US',{maximumFractionDigits:6})+' USDG'}</strong></span><USDGSwap direction="get" onReturn={()=>void balance.refetch()} /><USDGSwap direction="swap" amount={value??0n} disabled={value===undefined||value===0n} onReturn={()=>void balance.refetch()} /></section>;
}
