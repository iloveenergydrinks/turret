import {stockIdentities,USDG} from './prepare-stock-deployment.mjs';
import {keccak256} from 'viem';
export const addr=n=>'0x'+n.toString(16).padStart(40,'0');
export const fixtureCode='0x60006000';
export function stockInput(){
  return {chainId:'4663',deadline:'1000300',credit:{usdg:USDG,collateral:stockIdentities[0].collateral,
    primary:stockIdentities[0].primary,secondary:addr(11),guardian:addr(12),staleness:'86400',maxLtvBps:'3000',
    liquidationLtvBps:'4000',bonusBps:'500',deviationBps:'200',minimumDebt:'1000000'},
    executionGate:addr(14),usdgPricing:{primary:addr(15),secondary:addr(16),primaryMaxAge:'300',secondaryMaxAge:'300',maxDeviationBps:'200',maxTimestampSkew:'60'},
    treasury:addr(13),debtLimit:'1000000000',revenueFeeBps:'1000',borrowAprBps:'1000',
    pins:Object.fromEntries(['usdg','collateral','stockFeed','stockGuard','executionGate','usdgPrimary','usdgSecondary'].map(k=>[k,keccak256(fixtureCode)]))};
}
