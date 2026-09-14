import {describe,it,expect} from 'vitest';
import {validateP2PRegistry} from './client';
import {P2P_ASSETS} from './asset-catalog';
import {registry} from './admission-fixture';
const token='0xa26992C4268A8a78a4d872FE4BDAD2Ed03aC287d';
describe('MANY token admission',()=>{
 const candidate={...registry.markets.find(m=>m.version===3)!,collateralSymbol:'MANY',collateralName:'Manyways Inference',collateralToken:token,address:'0x1111111111111111111111111111111111111111',vaultImplementation:'0x2222222222222222222222222222222222222222'};
 it('accepts MANY identity while preserving all existing markets',()=>{
  const result=validateP2PRegistry({...registry,markets:[...registry.markets,candidate]},'turret.capital');
  expect(result.markets).toHaveLength(registry.markets.length+1);
  expect(result.markets.at(-1)?.collateralToken).toBe(token);
 });
 it('rejects an unrelated contract under the MANY ticker',()=>{
  expect(()=>validateP2PRegistry({...registry,markets:[...registry.markets,{...candidate,collateralToken:'0x385F4f8ae47651ce5F58F5265395a669f8281e18'}]},'turret.capital')).toThrow();
 });
 it('has exactly one MANY catalogue identity',()=>{
  expect(P2P_ASSETS.filter(a=>a.symbol==='MANY').map(a=>a.address)).toEqual([token]);
 });
});
