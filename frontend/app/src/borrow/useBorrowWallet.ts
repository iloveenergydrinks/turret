import {useEffect,useState} from 'react';
import {erc20Abi,parseAbi,type Address} from 'viem';
import {useAccount,usePublicClient} from 'wagmi';
import {freshSnapshot} from './borrow-estimate';
const abi=parseAbi(['function positions(address) view returns(uint256,uint256,uint256,uint256,uint256)','function positionDebt(address) view returns(uint256)','function maxLtvBps() view returns(uint16)']);
export type WalletMarket={engine:string;collateral:string};
export type WalletFacts={balance:bigint;collateral:bigint;debt:bigint;maxLtvBps:number;timestamp:bigint};
/** Read-only, block-pinned wallet discovery. No price or authorization is inferred here. */
export function useBorrowWallet(markets:WalletMarket[]) {
 const {address,chainId}=useAccount(),client=usePublicClient({chainId:4663});
 const [result,setResult]=useState<{account:string;rows:Record<string,WalletFacts|null>}>(),[now,setNow]=useState(Date.now);
 const connected=!!address&&chainId===4663;
 useEffect(()=>{
  if(!address||!client||chainId!==4663||!markets.length)return;
  let alive=true,busy=false;
  const refresh=async()=>{
   if(!alive||busy||document.visibilityState==='hidden')return;
   busy=true;
   try {
    const block=await client.getBlock();
    if(!block.number||!freshSnapshot(block.timestamp,Date.now()))throw Error('Stale block');
    const rows:Record<string,WalletFacts|null>={};let index=0;
    // Bound parallel markets; the RPC transport batches their independent reads.
    await Promise.all(Array.from({length:3},async()=>{
     while(alive&&index<markets.length){const market=markets[index++]!;
      try {
       const engine=market.engine as Address,token=market.collateral as Address,blockNumber=block.number!;
       const [balance,decimals,position,debt,maxLtvBps]=await Promise.all([
        client.readContract({address:token,abi:erc20Abi,functionName:'balanceOf',args:[address],blockNumber}),
        client.readContract({address:token,abi:erc20Abi,functionName:'decimals',blockNumber}),
        client.readContract({address:engine,abi,functionName:'positions',args:[address],blockNumber}),
        client.readContract({address:engine,abi,functionName:'positionDebt',args:[address],blockNumber}),
        client.readContract({address:engine,abi,functionName:'maxLtvBps',blockNumber}),
       ]);
       if(decimals!==18||maxLtvBps>10000)throw Error('Unsupported market');
       rows[market.engine]={balance,collateral:position[0],debt,maxLtvBps,timestamp:block.timestamp};
      }catch{rows[market.engine]=null;}
     }
    }));
    if(alive)setResult({account:address,rows});
   }catch{if(alive)setResult({account:address,rows:Object.fromEntries(markets.map(m=>[m.engine,null]))});}
   finally{busy=false;}
  };
  void refresh();const timer=setInterval(refresh,20000);
  window.addEventListener('focus',refresh);document.addEventListener('visibilitychange',refresh);
  return()=>{alive=false;clearInterval(timer);window.removeEventListener('focus',refresh);document.removeEventListener('visibilitychange',refresh);};
 },[address,chainId,client,markets]);
 useEffect(()=>{const clock=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(clock);},[]);
 const rows=connected&&result?.account===address?result.rows:{};
 const facts=Object.fromEntries(markets.map(m=>{const value=rows[m.engine];return [m.engine,value&&freshSnapshot(value.timestamp,now)?value:value===undefined?undefined:null];}));
 return {address,connected,wrongChain:!!address&&!connected,facts};
}
