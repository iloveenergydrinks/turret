// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import {useState} from 'react';
import {cleanup, fireEvent, render, screen, within} from '@testing-library/react';
import {afterEach, expect, test, vi} from 'vitest';
import {LoanInterestField, useLoanInterest} from './LoanInterestField';
import {RequestTermsForm} from '../../screens/P2PLoansScreen/BorrowerRequests';
import {NegotiationEditor} from '../../screens/P2PLoansScreen/NegotiationTerms';
import type {Deployment} from '../../p2p/client';
vi.mock('../../screens/P2PLoansScreen/CollateralMarketPrice',()=>({CollateralMarketPrice:()=>null,hasWeekendPrices:()=>false}));
afterEach(cleanup);
function Harness({disabled=false}:{disabled?:boolean}) {
 const [principal,setPrincipal]=useState('100'); const model=useLoanInterest(principal,6,'5');
 return <><label>Principal<input value={principal} onChange={e=>setPrincipal(e.target.value)}/></label><LoanInterestField model={model} duration="30" decimals={6} disabled={disabled}/></>;
}
test('unit choice is accessible and the preview follows the selected mode',()=>{
 render(<Harness/>);expect(screen.getByRole('button',{name:'USDG'})).toHaveAttribute('aria-pressed','true');
 fireEvent.click(screen.getByRole('button',{name:'%'}));expect(screen.getByLabelText('Total interest · %')).toHaveValue('5');
 fireEvent.change(screen.getByLabelText('Principal'),{target:{value:'200'}});
 expect(within(screen.getByLabelText('Repayment breakdown')).getByText('210 USDG')).toBeVisible();
 fireEvent.click(screen.getByRole('button',{name:'USDG'}));expect(screen.getByLabelText('Total interest · USDG')).toHaveValue('10');
 fireEvent.change(screen.getByLabelText('Principal'),{target:{value:'300'}});
 expect(within(screen.getByLabelText('Repayment breakdown')).getByText('310 USDG')).toBeVisible();
});
test('disabled and invalid controls cannot expose a stale repayment',()=>{
 const view=render(<Harness disabled/>);expect(screen.getByRole('button',{name:'%'})).toBeDisabled();expect(screen.getByLabelText('Total interest · USDG')).toBeDisabled();
 view.rerender(<Harness/>);fireEvent.click(screen.getByRole('button',{name:'%'}));fireEvent.change(screen.getByLabelText('Total interest · %'),{target:{value:'-5'}});
 expect(screen.queryByRole('alert')).not.toBeInTheDocument();fireEvent.blur(screen.getByLabelText('Total interest · %'));
 expect(screen.getByRole('alert')).toHaveTextContent('Enter a percentage');expect(screen.getByLabelText('Total interest · %')).toHaveAttribute('aria-invalid','true');
 expect(screen.queryByText('105 USDG')).not.toBeInTheDocument();
});
test('converting an existing USDG fee requires principal and never discards it',()=>{
 render(<Harness/>);fireEvent.change(screen.getByLabelText('Principal'),{target:{value:''}});
 expect(screen.getByRole('button',{name:'%'})).toBeDisabled();expect(screen.getByLabelText('Total interest · USDG')).toHaveValue('5');
 fireEvent.change(screen.getByLabelText('Principal'),{target:{value:'100'}});fireEvent.click(screen.getByRole('button',{name:'%'}));
 expect(screen.getByLabelText('Total interest · %')).toHaveValue('5');
});
const market={address:'0x1111111111111111111111111111111111111111',loanDecimals:6,collateralDecimals:18,loanSymbol:'USDG',collateralSymbol:'AAPL',version:3} as unknown as Deployment;
const terms={principal:'100000000',interest:'5000000',collateral:'1000000000000000000',durationDays:30,expiresAt:Math.floor(Date.now()/1000)+7*86400};
test.each(['request','proposal'] as const)('%s signs the exact percentage-derived terms and invalidates prior review',label=>{
 const submit=vi.fn().mockResolvedValue(undefined);render(<RequestTermsForm market={market} initial={terms} disabled={false} label={label} onSubmit={submit}/>);
 fireEvent.click(screen.getByRole('button',{name:'%'}));fireEvent.change(screen.getByLabelText('Total interest · %'),{target:{value:'7.5'}});
 fireEvent.click(screen.getByRole('button',{name:label==='request'?'Review request':'Review proposal'}));
 const signName=label==='request'?'Sign and publish request':'Sign and publish proposal';
 expect(screen.getByRole('button',{name:signName})).toBeVisible();
 fireEvent.change(screen.getByLabelText('USDG to borrow'),{target:{value:'200'}});expect(screen.queryByRole('button',{name:signName})).not.toBeInTheDocument();
 fireEvent.click(screen.getByRole('button',{name:label==='request'?'Review request':'Review proposal'}));fireEvent.click(screen.getByRole('button',{name:signName}));
 expect(submit).toHaveBeenCalledWith(expect.objectContaining({principal:'200000000',interest:'15000000'}));
});
test('negotiated replacements sign percentage-derived amounts and unit switches clear review',()=>{
 const submit=vi.fn().mockResolvedValue(undefined);render(<NegotiationEditor market={market} original={terms} initial={terms} sourceExpiry={terms.expiresAt} disabled={false} onSubmit={submit}/>);
 fireEvent.click(screen.getByRole('button',{name:'%'}));fireEvent.change(screen.getByLabelText('Total interest · %'),{target:{value:'2.5'}});
 fireEvent.click(screen.getByRole('button',{name:'Review proposed terms'}));expect(screen.getByRole('button',{name:'Sign and send proposal'})).toBeVisible();
 fireEvent.click(screen.getByRole('button',{name:'USDG'}));expect(screen.queryByRole('button',{name:'Sign and send proposal'})).not.toBeInTheDocument();
 expect(screen.getByLabelText('Total interest · USDG')).toHaveValue('2.5');
 fireEvent.click(screen.getByRole('button',{name:'Review proposed terms'}));fireEvent.click(screen.getByRole('button',{name:'Sign and send proposal'}));
 expect(submit).toHaveBeenCalledWith(expect.objectContaining({principal:'100000000',interest:'2500000'}),expect.any(Number));
});
