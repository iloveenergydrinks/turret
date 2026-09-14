const failure=name=>Object.assign(new Error(name),{name});

// Bound request starts, not completion: one slow RPC must not stall every read.
// Queue deadlines are separate from HTTP timeouts, which begin only on release.
export function createRpcPacer(maxRps,{maxQueued=64,maxWaitMs=5000,
 now=()=>performance.now(),schedule=setTimeout}={}){
 if(!Number.isSafeInteger(maxRps)||maxRps<0||maxRps>1000)throw failure('InvalidRpcRate');
 if(maxRps===0)return task=>task();
 if(!Number.isSafeInteger(maxQueued)||maxQueued<1||!Number.isSafeInteger(maxWaitMs)||maxWaitMs<1)
  throw failure('InvalidRpcQueue');
 const interval=1000/maxRps,queue=[];
 let nextStart=-Infinity,timer;
 const pump=()=>{
  if(timer!==undefined)return;
  const at=now();
  while(queue.length&&queue[0].deadline<=at)queue.shift().reject(failure('RpcQueueExpired'));
  if(!queue.length)return;
  const delay=Math.max(0,nextStart-at);
  if(delay>0){
   timer=schedule(()=>{timer=undefined;pump();},Math.min(delay,queue[0].deadline-at));
   return;
  }
  const item=queue.shift();
  // Base the next slot on the actual start; a delayed timer cannot release a burst.
  nextStart=at+interval;
  try{item.resolve(item.task());}catch(error){item.reject(error);}
  pump();
 };
 return task=>new Promise((resolve,reject)=>{
  if(queue.length>=maxQueued){reject(failure('RpcQueueFull'));return;}
  queue.push({task,resolve,reject,deadline:now()+maxWaitMs});
  pump();
 });
}

// Reuse one pacer for public and wallet transports on the same provider.
// The underlying transport owns error handling and retains retryCount: 0.
export function paceRpcTransport(transport,pacer){
 return options=>{
  const base=transport(options);
  const request=(args,requestOptions)=>pacer(()=>base.request(args,requestOptions));
  return {...base,config:{...base.config,request},request};
 };
}
