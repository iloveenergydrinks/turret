import {IsolatedOracleWorker} from './isolated-worker.mjs';
import {prepareApi3UsdgPublication} from './api3-usdg.mjs';
import {readApi3UsdgReadiness} from './api3-readiness.mjs';

export class Api3UsdgWorker extends IsolatedOracleWorker {
  constructor(args){
    super({...args,prepare:prepareApi3UsdgPublication,readiness:readApi3UsdgReadiness,
      kind:'stock-api3-usdg',transactionKind:'api3_usdg_update',snapshotKey:'api3UsdgOracleSnapshot',
      transportCode:'api3_usdg_oracle_online',transportMessage:'USDG oracle operator notification transport check.',
      verificationFeeReserve:0n,recoverBeforeProvider:true});
  }
}
