// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,expect,test} from 'vitest';
import {FieldLabel} from './FieldInfo';
afterEach(cleanup);
function Form(){return <form onSubmit={e=>{e.preventDefault();throw Error('Info must not submit the form')}}><FieldLabel htmlFor="amount" topic="principal" helpLabel="loan amount">USDG to borrow</FieldLabel><input id="amount"/><button type="button">Next field</button></form>}
test('keeps the label associated with its input and makes the info icon a non-submit button',async()=>{
 render(<Form/>);expect(screen.getByLabelText('USDG to borrow')).toHaveAttribute('id','amount');
 const info=screen.getByRole('button',{name:'About loan amount'});expect(info).toHaveAttribute('type','button');
 fireEvent.click(info);const tip=await screen.findByRole('tooltip');expect(tip).toHaveTextContent('The USDG the borrower receives when the loan is accepted.');
 expect(info).toHaveAttribute('aria-describedby',tip.id);
});
test('Escape closes help without reopening it or dismissing the parent dialog',async()=>{
 render(<dialog open><Form/></dialog>);const info=screen.getByRole('button',{name:'About loan amount'});info.focus();fireEvent.click(info);
 const tip=await screen.findByRole('tooltip');await waitFor(()=>expect(tip).toContainElement(document.activeElement as HTMLElement));
 const event=new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true});document.dispatchEvent(event);
 expect(event.defaultPrevented).toBe(true);await waitFor(()=>expect(info).toHaveAttribute('aria-expanded','false'));
 await new Promise(resolve=>setTimeout(resolve,250));expect(info).toHaveAttribute('aria-expanded','false');expect(screen.getByRole('dialog')).toHaveAttribute('open');expect(document.activeElement).toBe(info);
});
test('keyboard focus opens help and moving to another field keeps focus there',async()=>{
 render(<Form/>);const info=screen.getByRole('button',{name:'About loan amount'});info.focus();await screen.findByRole('tooltip');
 const next=screen.getByRole('button',{name:'Next field'});next.focus();await waitFor(()=>expect(info).toHaveAttribute('aria-expanded','false'));expect(document.activeElement).toBe(next);
});
