import {decodeEventLog,erc20Abi,type Hex} from 'viem';
import {SWAP_USDG} from './usdg-swap';
export function receivedBorrowUSDG(logs:readonly {address:string;data:Hex;topics:readonly Hex[]}[],pool:string,wallet:string):bigint {
 let received=0n;
 for(const log of logs){
  if(log.address.toLowerCase()!==SWAP_USDG.toLowerCase())continue;
  try{const event=decodeEventLog({abi:erc20Abi,eventName:'Transfer',data:log.data,topics:log.topics as [Hex,...Hex[]]});
   if(event.args.from.toLowerCase()===pool.toLowerCase()&&event.args.to.toLowerCase()===wallet.toLowerCase())received+=event.args.value;
  }catch{/* Other USDG events are not loan proceeds. */}
 }
 return received;
}
