import {describe,it,expect} from 'vitest';
import {validateP2PRegistry} from './client';
import {P2P_ASSETS} from './asset-catalog';
import {registry} from './admission-fixture';
const token='0x05a3d1Cd21d0C88145E82600E62e7E496e0F222B';
describe('AMC stock token admission',()=>{
 const candidate={...registry.markets.find(m=>m.version===3)!,collateralSymbol:'AMC',collateralName:'AMC Entertainment • Robinhood Token',collateralToken:token,address:'0x1111111111111111111111111111111111111111',vaultImplementation:'0x2222222222222222222222222222222222222222'};
 it('accepts AMC identity while preserving all existing markets',()=>{
  const result=validateP2PRegistry({...registry,markets:[...registry.markets,candidate]},'turret.capital');
  expect(result.markets).toHaveLength(registry.markets.length+1);
  expect(result.markets.at(-1)?.collateralToken).toBe(token);
 });
 it('rejects the unrelated AMC memecoin under the stock ticker',()=>{
  expect(()=>validateP2PRegistry({...registry,markets:[...registry.markets,{...candidate,collateralToken:'0x385F4f8ae47651ce5F58F5265395a669f8281e18'}]},'turret.capital')).toThrow();
 });
 it('has exactly one AMC catalogue identity',()=>{
  expect(P2P_ASSETS.filter(a=>a.symbol==='AMC').map(a=>a.address)).toEqual([token]);
 });
});
