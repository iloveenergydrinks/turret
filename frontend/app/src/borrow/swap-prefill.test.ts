import {expect,it} from 'vitest';
import {swapCollateralPrefill} from './swap-prefill';
it('prefills only the same wallet and caps collateral to its current balance',()=>{
 const query=new URLSearchParams({collateralAmount:'1.2',swapAccount:'0xabc'});
 expect(swapCollateralPrefill(query,'0xABC',2n*10n**18n)).toBe('1.2');
 expect(swapCollateralPrefill(query,'0xabc',5n*10n**17n)).toBe('0.5');
 expect(swapCollateralPrefill(query,'0xdef',2n*10n**18n)).toBeNull();
 expect(swapCollateralPrefill(query,'0xabc',0n)).toBeNull();
});
it('rejects invalid, negative and overprecision navigation amounts',()=>{
 for(const collateralAmount of ['-1','1e6','0','1.1234567890123456789','NaN','Infinity'])expect(swapCollateralPrefill(new URLSearchParams({collateralAmount,swapAccount:'a'}),'a',10n**30n)).toBeNull();
});
