import {describe,it,expect} from 'vitest';
import {parseUnits,encodeEventTopics,encodeAbiParameters,erc20Abi} from 'viem';
import {borrowCapacity,startingLtv,estimatedInterest,repaymentShortfall,freshSnapshot,closeFundingBudget} from './borrow-estimate';
import {usdgSwapLink,SWAP_USDG} from './usdg-swap';
import {receivedBorrowUSDG} from './confirmed-usdg';
const u=(s:string)=>parseUnits(s,6), c=(s:string)=>parseUnits(s,18);
const state={collateral:c('2'),debt:u('10'),borrowingPrice:c('100'),price:c('100'),maxLtvBps:3000,cash:u('200'),principal:u('10'),debtLimit:u('1000'),minimumDebt:u('20'),riskPaused:false};
describe('borrow estimates',()=>{
 it('accounts for existing collateral, new collateral and debt',()=>expect(borrowCapacity(state,c('1'))).toBe(u('80')));
 it('caps additional borrowing by cash and remaining market ceiling',()=>{expect(borrowCapacity({...state,cash:u('25')},c('1'))).toBe(u('25'));expect(borrowCapacity({...state,debtLimit:u('27')},c('1'))).toBe(u('17'));});
 it('never makes dust below minimum or exhausted limits borrowable',()=>{expect(borrowCapacity({...state,debt:0n,cash:u('10')},c('1'))).toBe(0n);expect(borrowCapacity({...state,debtLimit:0n},c('1'))).toBe(0n);});
 it('requires a borrow price and unpaused market',()=>{expect(borrowCapacity({...state,borrowingPrice:null},0n)).toBeNull();expect(borrowCapacity({...state,riskPaused:true},0n)).toBeNull();});
 it('shows LTV against total post-loan debt and collateral',()=>expect(startingLtv(state,c('1'),u('50'))).toBe(2000n));
 it('rounds interest upwards to the USDG precision',()=>expect(estimatedInterest(u('365'),1000,30)).toBe(u('3')));
 it('caps partial payment at debt but includes the full close buffer',()=>{expect(repaymentShortfall(u('30'),u('100'),u('70'),false)).toBe(u('40'));expect(repaymentShortfall(u('100'),u('100'),u('101'),true)).toBe(u('1'));expect(repaymentShortfall(u('100'),u('100'),u('200'),false)).toBe(0n);});
 it('expires old or future snapshots and expired proofs',()=>{expect(freshSnapshot(100n,120000,125n)).toBe(true);expect(freshSnapshot(100n,130000)).toBe(false);expect(freshSnapshot(130n,120000)).toBe(false);expect(freshSnapshot(100n,120000,120n)).toBe(false);});
});
describe('swap handoff',()=>{
 it('prefills the correct side with exact six-decimal USDG units',()=>{const get=new URL(usdgSwapLink('get',u('32.123456')));expect(get.searchParams.get('chain')).toBe('robinhood');expect(get.searchParams.get('outputCurrency')).toBe(SWAP_USDG);expect(get.searchParams.get('field')).toBe('output');expect(get.searchParams.get('value')).toBe('32.123456');const swap=new URL(usdgSwapLink('swap',u('15')));expect(swap.searchParams.get('inputCurrency')).toBe(SWAP_USDG);expect(swap.searchParams.get('field')).toBe('input');});
 it('rejects arbitrary URLs, same-token swaps and out-of-range amounts',()=>{expect(()=>usdgSwapLink('get',1n,'javascript:alert(1)')).toThrow();expect(()=>usdgSwapLink('get',1n,SWAP_USDG)).toThrow();expect(()=>usdgSwapLink('swap',2n**256n)).toThrow();});
 it('counts only USDG transfers from the loan pool to this wallet',()=>{const pool='0x1111111111111111111111111111111111111111',wallet='0x2222222222222222222222222222222222222222';const log={address:SWAP_USDG,data:encodeAbiParameters([{type:'uint256'}],[u('75')]),topics:encodeEventTopics({abi:erc20Abi,eventName:'Transfer',args:{from:pool,to:wallet}})};expect(receivedBorrowUSDG([log],pool,wallet)).toBe(u('75'));expect(receivedBorrowUSDG([log],wallet,pool)).toBe(0n);expect(receivedBorrowUSDG([{...log,address:pool}],pool,wallet)).toBe(0n);});
});

it("funding a full close includes five minutes of interest even for an empty wallet",()=>{const budget=closeFundingBudget(u("100"),1000);expect(budget).toBe(100000098n);expect(repaymentShortfall(0n,u("100"),budget,true)).toBe(budget);expect(closeFundingBudget(0n,1000)).toBe(0n);});
