function keeperIdentityReady(status,manifest,now=Date.now()){
 const s=status?.snapshot;
 const same=(a,b)=>typeof a==='string'&&typeof b==='string'&&a.toLowerCase()===b.toLowerCase();
 const binding=manifest.kind==='stock-pool'
  ?s?.marketKind==='stock'&&same(s.engine,manifest.vault)&&same(s.pool,manifest.pool)
   &&same(s.poolCodeHash,manifest.poolCodeHash)&&same(s.collateral,manifest.markets?.[0]?.collateral)
   &&same(s.executionGate,manifest.executionGate)
  :same(s?.vault,manifest.vault);
 return !status?.lastError&&s?.mode==='execute'&&s.reconciled===true
  &&s.chainId===4663&&binding&&same(s.codeHash,manifest.vaultCodeHash)
  &&same(s.account,manifest.keeper)
  &&Number.isSafeInteger(s.checkedAt)&&s.checkedAt<=now+30000&&now-s.checkedAt<=30000;
}

export function keeperReady(status,manifest,now=Date.now()){
 return status?.operational===true&&keeperIdentityReady(status,manifest,now);
}

export function keeperReadyForLiveness(status,manifest,now=Date.now()){
 const critical=status?.snapshot?.incidents?.filter(x=>x.severity==='critical'&&x.code!=='execution_liveness_unavailable')??[];
 return status?.alertDelivery?.delivered===true&&critical.length===0&&keeperIdentityReady(status,manifest,now);
}
