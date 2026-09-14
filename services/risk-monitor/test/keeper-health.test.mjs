import test from 'node:test';
import assert from 'node:assert/strict';
import {keeperReady,keeperReadyForLiveness} from '../src/keeper-health.mjs';
test('borrow admission requires the correct funded execution worker with fresh reconciled status',()=>{
 const now=Date.now(),manifest={vault:'0xddd',vaultCodeHash:'0xaaa',keeper:'0xbbb'};
 const healthy={operational:true,lastError:null,snapshot:{chainId:4663,vault:'0xddd',mode:'execute',reconciled:true,codeHash:'0xaaa',account:'0xbbb',checkedAt:now}};
 assert.equal(keeperReady(healthy,manifest,now),true);
 for(const patch of [{chainId:1},{vault:'0xeee'},{mode:'observe'},{reconciled:false},{codeHash:'0xccc'},{account:'0xccc'},{checkedAt:now-30001},{checkedAt:now+30001},{checkedAt:undefined}])assert.equal(keeperReady({...healthy,snapshot:{...healthy.snapshot,...patch}},manifest,now),false);
 assert.equal(keeperReady({...healthy,operational:false},manifest,now),false);
 assert.equal(keeperReady({...healthy,lastError:{code:'RPCError'}},manifest,now),false);
});
test('liveness bootstrap accepts an otherwise ready keeper waiting only for its proof',()=>{
 const now=Date.now(),manifest={kind:'chainlink-guarded-pilot',vault:'0xaaa',vaultCodeHash:'0xbbb',keeper:'0xddd'};
 const status={operational:false,lastError:null,alertDelivery:{delivered:true},snapshot:{vault:'0xaaa',mode:'execute',reconciled:true,chainId:4663,
  codeHash:'0xbbb',account:'0xddd',checkedAt:now,incidents:[{code:'execution_liveness_unavailable',severity:'critical'}]}};
 assert.equal(keeperReady(status,manifest,now),false);
 assert.equal(keeperReadyForLiveness(status,manifest,now),true);
 status.snapshot.incidents.push({code:'usdg_reserve',severity:'critical'});
 assert.equal(keeperReadyForLiveness(status,manifest,now),false);
});
