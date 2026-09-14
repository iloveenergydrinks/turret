import { decodeEventLog, encodeFunctionData, getAddress, keccak256, parseAbi, type Address, type Hash, type PublicClient, type WalletClient } from 'viem';
import type { CashbackConfig } from './client';
export const publicEnrollmentAbi = parseAbi([
 'function join()', 'function joined(address) view returns(bool)', 'function eligibleEngine(address) view returns(bool)',
 'function WALLET_CAP() view returns(uint256)', 'function BUDGET_CAP() view returns(uint256)',
 'function totalFunded() view returns(uint256)', 'function totalCommitted() view returns(uint256)',
 'function startsAt() view returns(uint64)', 'function endsAt() view returns(uint64)',
 'function enrollmentPaused() view returns(bool)', 'function rewardToken() view returns(address)',
 'function operator() view returns(address)', 'function treasury() view returns(address)',
 'event Enrolled(address indexed borrower,address indexed engine,uint256 cap,uint64 startsAt)',
]);
export type EnrollmentInput = {client:PublicClient;config:CashbackConfig;account:Address;engine:Address};
export async function readPublicEnrollment({client,config,account,engine}:EnrollmentInput) {
 if(!config.deployment?.publicEnrollment || await client.getChainId()!==config.chainId) throw new Error('Public cashback is unavailable on this network');
 const address=getAddress(config.deployment.address),block=await client.getBlock();
 const code=await client.getCode({address,blockNumber:block.number});
 if(!code || keccak256(code)!==config.deployment.runtimeHash)throw new Error('Cashback contract could not be verified');
 const read=(functionName:any,args:[]|[Address]=[])=>client.readContract({address,abi:publicEnrollmentAbi,functionName,args,blockNumber:block.number});
 const [token,cap,budget,funded,committed,joined,eligible,paused,start,end,operator,treasury]=await Promise.all([
  read('rewardToken'),read('WALLET_CAP'),read('BUDGET_CAP'),read('totalFunded'),read('totalCommitted'),read('joined',[account]),
  read('eligibleEngine',[engine]),read('enrollmentPaused'),read('startsAt'),read('endsAt'),read('operator'),read('treasury')]);
 if(getAddress(token as string)!==getAddress(config.rewardToken)||cap!==25_000000n||budget!==1000_000000n
  ||(funded as bigint)>budget||(committed as bigint)>(funded as bigint))throw new Error('Public cashback funding mismatch');
 return {address,joined:joined as boolean,eligible:eligible as boolean,paused:paused as boolean,
  startsAt:Number(start),endsAt:Number(end),now:Number(block.timestamp),slots:Number(((funded as bigint)-(committed as bigint))/25_000000n),
  excluded:[operator,treasury].some(value=>getAddress(value as string)===getAddress(account))};
}
export async function submitPublicEnrollment(input:EnrollmentInput & {wallet:WalletClient}) {
 const state=await readPublicEnrollment(input);
 if(state.joined)throw new Error('This wallet is already enrolled');
 if(!state.eligible||state.excluded||state.paused||state.slots<1||state.now<state.startsAt||state.now>=state.endsAt)
  throw new Error('No cashback reservation is available for this wallet and market');
 if(await input.wallet.getChainId()!==input.config.chainId||!(await input.wallet.getAddresses()).some(a=>getAddress(a)===getAddress(input.account)))
  throw new Error('Reconnect the wallet shown in the enrollment review');
 const {request}=await input.client.simulateContract({address:state.address,abi:publicEnrollmentAbi,functionName:'join',account:input.account});
 return input.wallet.writeContract({...request,account:input.account,chain:input.wallet.chain});
}
export async function verifyPublicEnrollment(input:EnrollmentInput & {hash:Hash}) {
 const state=await readPublicEnrollment(input);
 const [receipt,tx]=await Promise.all([input.client.getTransactionReceipt({hash:input.hash}),input.client.getTransaction({hash:input.hash})]);
 if(tx.to?.toLowerCase()!==state.address.toLowerCase()||getAddress(tx.from)!==getAddress(input.account)
  ||tx.input!==encodeFunctionData({abi:publicEnrollmentAbi,functionName:'join'}))throw new Error('Transaction does not match this enrollment');
 if(receipt.status!=='success')throw new Error('Enrollment reverted. No cashback was reserved by this transaction.');
 const confirmed=receipt.logs.some(log=>{if(log.address.toLowerCase()!==state.address.toLowerCase())return false;try{
  const e=decodeEventLog({abi:publicEnrollmentAbi,data:log.data,topics:log.topics});
  return e.eventName==='Enrolled'&&getAddress(e.args.borrower)===getAddress(input.account)&&getAddress(e.args.engine)===getAddress(input.engine)&&e.args.cap===25_000000n;
 }catch{return false;}});
 if(!confirmed||!state.joined)throw new Error('Receipt does not confirm the cashback reservation');
 return state;
}
