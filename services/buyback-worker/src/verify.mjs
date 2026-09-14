import {keccak256,parseAbi} from 'viem';import {abi} from './worker.mjs';import {SWAP_CODE,SWAP_ROUTER,SWAP_TARGET,TOKEN,USDG} from './quote.mjs';
const same=(a,b)=>String(a).toLowerCase()===String(b).toLowerCase();
export async function verifyDeployment(client,peer,config){
 const [ca,cb,a,b]=await Promise.all([client.getChainId(),peer.getChainId(),client.getBlock(),peer.getBlock()]);if(ca!==4663||cb!==4663)throw Error('wrong_chain');
 const number=(a.number<b.number?a.number:b.number)-2n;const [head,other]=await Promise.all([client.getBlock({blockNumber:number}),peer.getBlock({blockNumber:number})]);if(head.hash!==other.hash||Math.abs(Date.now()/1000-Number(head.timestamp))>60)throw Error('rpc_disagreement_or_stale');
 const read=(functionName,args=[])=>client.readContract({address:config.module,abi,functionName,args,blockNumber:number});
 const expected={treasury:config.wallet,keeper:config.operator,usdg:USDG,turret:TOKEN,swapRouter:SWAP_ROUTER,swapTarget:SWAP_TARGET,reserveFloor:100000000n,HOURLY_RATE:67000000000000000n};
 await Promise.all(Object.entries(expected).map(async([name,value])=>{if(!same(await read(name),value))throw Error('module_configuration_changed');}));
 const hashes={...SWAP_CODE,[config.module]:config.runtimeHash,[TOKEN]:'0xc6c38a3a9c1d6d15df223c863334471746f85c389a524540f2bd336bbb535d7c',[USDG]:'0x864cc9ad53b338b82da1f7cab85ab0b3d5c8861acb422b6fec63cf36234f36a6','0x68184C449E1a8f34fA18d289737129FD27B66f8F':'0x3a551ac5c744af57e68a1d1431ac403c0f516ffd7d224a75746aee11fc4f3baf'};
 await Promise.all(Object.entries(hashes).map(async([address,hash])=>{const code=await client.getCode({address,blockNumber:number});if(!hash||!code||keccak256(code)!==hash)throw Error('runtime_changed');}));
 const slot=await client.getStorageAt({address:USDG,slot:'0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc',blockNumber:number});if(!same('0x'+slot.slice(-40),'0x68184C449E1a8f34fA18d289737129FD27B66f8F'))throw Error('USDG_implementation_changed');
 if((await client.getBlock({blockNumber:number})).hash!==head.hash)throw Error('reorg');return head;
}
