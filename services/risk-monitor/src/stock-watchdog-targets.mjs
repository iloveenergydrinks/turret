const address=/^0x[0-9a-fA-F]{40}$/;
const hash=/^0x[0-9a-fA-F]{64}$/;

const demand=(ok,message)=>{if(!ok)throw Error(message);};

export function stockWatchdogTargets(raw,legacy={}) {
  if(!raw)return [{symbol:'AAPL',keeper:{
    statusUrl:legacy.KEEPER_STATUS_URL,statusToken:legacy.KEEPER_STATUS_TOKEN,
    expectedMode:legacy.KEEPER_EXPECTED_MODE,expectedVault:legacy.KEEPER_EXPECTED_VAULT,
    expectedPool:legacy.KEEPER_EXPECTED_POOL,expectedGate:legacy.KEEPER_EXPECTED_GATE,
    expectedCollateral:legacy.KEEPER_EXPECTED_COLLATERAL,expectedAccount:legacy.KEEPER_EXPECTED_ACCOUNT,
    expectedCodeHash:legacy.KEEPER_EXPECTED_CODE_HASH,expectedPoolCodeHash:legacy.KEEPER_EXPECTED_POOL_CODE_HASH,
  },risk:{statusUrl:legacy.RISK_STATUS_URL,statusToken:legacy.RISK_STATUS_TOKEN,
    expectedMode:legacy.RISK_EXPECTED_MODE,expectedVault:legacy.RISK_EXPECTED_VAULT}}];
  let targets;try{targets=JSON.parse(raw);}catch{throw Error('Invalid stock watchdog targets');}
  demand(Array.isArray(targets)&&targets.length>0&&targets.length<=12,'Invalid stock watchdog target count');
  const symbols=new Set(),urls=new Set();
  for(const target of targets){
    demand(target&&/^[A-Z0-9]{1,10}$/.test(target.symbol),'Invalid stock watchdog symbol');
    demand(!symbols.has(target.symbol),'Duplicate stock watchdog symbol');symbols.add(target.symbol);
    demand(target.keeper&&target.risk,'Incomplete stock watchdog target');
    for(const role of ['keeper','risk']){
      const item=target[role];let url;try{url=new URL(item.statusUrl);}catch{throw Error('Invalid stock watchdog URL');}
      demand(url.protocol==='https:'&&!url.username&&!url.password&&!url.search&&!url.hash,'Unsafe stock watchdog URL');
      demand(typeof item.statusToken==='string'&&item.statusToken.length>=32,'Invalid stock watchdog token');
      demand(['observe','execute'].includes(item.expectedMode),'Invalid stock watchdog mode');
      demand(address.test(item.expectedVault),'Invalid stock watchdog vault');
      const key=`${role}:${url.href}`;demand(!urls.has(key),'Duplicate stock watchdog URL');urls.add(key);
    }
    for(const key of ['expectedPool','expectedGate','expectedCollateral','expectedAccount'])demand(address.test(target.keeper[key]),`Invalid keeper ${key}`);
    for(const key of ['expectedCodeHash','expectedPoolCodeHash'])demand(hash.test(target.keeper[key]),`Invalid keeper ${key}`);
  }
  return targets;
}

export function targetEnvironment(target,role) {
  if(role==='keeper')return {
    KEEPER_STATUS_URL:target.keeper.statusUrl,KEEPER_STATUS_TOKEN:target.keeper.statusToken,
    KEEPER_EXPECTED_MODE:target.keeper.expectedMode,KEEPER_EXPECTED_KIND:'stock',
    KEEPER_EXPECTED_VAULT:target.keeper.expectedVault,KEEPER_EXPECTED_POOL:target.keeper.expectedPool,
    KEEPER_EXPECTED_GATE:target.keeper.expectedGate,KEEPER_EXPECTED_COLLATERAL:target.keeper.expectedCollateral,
    KEEPER_EXPECTED_ACCOUNT:target.keeper.expectedAccount,KEEPER_EXPECTED_CODE_HASH:target.keeper.expectedCodeHash,
    KEEPER_EXPECTED_POOL_CODE_HASH:target.keeper.expectedPoolCodeHash,
  };
  return {RISK_STATUS_URL:target.risk.statusUrl,RISK_STATUS_TOKEN:target.risk.statusToken,
    RISK_EXPECTED_MODE:target.risk.expectedMode,RISK_EXPECTED_VAULT:target.risk.expectedVault};
}
