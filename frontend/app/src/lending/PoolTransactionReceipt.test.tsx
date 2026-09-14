// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import {render,screen,cleanup} from '@testing-library/react';
import {afterEach,it,expect} from 'vitest';
import {PoolTransactionReceipt} from './PoolTransactionReceipt';
afterEach(cleanup);
const confirmation={kind:'lend' as const,amount:100000000n,hash:`0x${'ab'.repeat(32)}` as const,block:20n};
it('does not present Done when reward activation is unfinished',()=>{
 render(<PoolTransactionReceipt confirmation={confirmation} symbol="AAPL" state={null} onDone={()=>{}} rewardActivation rewardStatus="needed"/>);
 expect(screen.queryByRole('button',{name:'Done'})).not.toBeInTheDocument();
 expect(screen.getByText(/finish activation below before leaving/)).toBeVisible();
});
it('presents completion after reward activation is verified',()=>{
 render(<PoolTransactionReceipt confirmation={confirmation} symbol="AAPL" state={null} onDone={()=>{}} rewardActivation rewardStatus="active"/>);
 expect(screen.getByRole('button',{name:'Done'})).toBeVisible();
 expect(screen.getByText(/deposit and TURRET reward activation are complete/)).toBeVisible();
});
it('does not trap a lender in activation after the campaign ends',()=>{
 render(<PoolTransactionReceipt confirmation={confirmation} symbol="AAPL" state={null} onDone={()=>{}} rewardActivation rewardStatus="unavailable"/>);
 expect(screen.getByRole('button',{name:'Done'})).toBeVisible();
 expect(screen.getByText(/TURRET rewards are currently unavailable/)).toBeVisible();
});
it('retains ordinary confirmation for pools without rewards',()=>{
 render(<PoolTransactionReceipt confirmation={confirmation} symbol="SLV" state={null} onDone={()=>{}}/>);
 expect(screen.getByRole('button',{name:'Done'})).toBeVisible();
});
