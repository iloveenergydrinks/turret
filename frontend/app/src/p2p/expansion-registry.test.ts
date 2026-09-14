import {describe,expect,it} from 'vitest';
import registry from '../../public/p2p-markets.json';
import alerts from './alert-market-scope.json';
import {checkP2PAlertCapabilities,p2pAlertScope} from './alerts-api';
import {validateDeployment} from './client';
import {memecoinMarkets} from '../borrow/memecoin-offers';
const markets=registry.markets.map(m=>validateDeployment(m,'turret.capital'));
describe('published memecoin expansion',()=>{
 it('validates every retained and new deployment and exposes eight memecoin markets',()=>{
  expect(markets).toHaveLength(45);
  expect(memecoinMarkets(markets).map(m=>m.collateralSymbol).sort()).toEqual(['CASHCAT','PONS','PIPEDOG','TENDIES','HMM','IF','JUGGERNAUT','YOLO'].sort());
 });
 it('preserves exact existing notification consent without expanding it to the new loans',()=>{
  const existing=markets.filter(m=>alerts.markets.some(a=>a.address===m.address.toLowerCase()));
  expect(existing).toHaveLength(39);expect(p2pAlertScope(existing)).toEqual(alerts);
  expect(()=>checkP2PAlertCapabilities({...alerts,protocol:'p2p',email:true,telegram:false,monitorReady:true,monitorOperational:true},alerts)).not.toThrow();
  expect(p2pAlertScope(markets)?.scope).not.toBe(alerts.scope);
 });
});
