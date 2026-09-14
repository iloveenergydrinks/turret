export function childEnvironment(base,row,port,kind,index){
 const env={...base,...row.env,PORT:String(port)};
 delete env.EXPANSION_CONFIG_JSON;
 delete env.EXPANSION_RISK_MANIFESTS_JSON;
 // Keep large, public market definitions separate from per-child credentials.
 // Each worker receives only the definition bound to its supervisor symbol.
 if(kind==='risk'&&base.EXPANSION_RISK_MANIFESTS_JSON!==undefined){
  if(env.RISK_MANIFEST_JSON!==undefined)throw Error(`Ambiguous risk manifest for ${row.symbol}`);
  let manifests;
  try{manifests=JSON.parse(base.EXPANSION_RISK_MANIFESTS_JSON);}catch{}
  const manifest=manifests&&typeof manifests==='object'&&!Array.isArray(manifests)&&Object.hasOwn(manifests,row.symbol)?manifests[row.symbol]:null;
  if(manifest?.kind!=='stock-pool'||!Array.isArray(manifest.markets)||manifest.markets.length!==1||manifest.markets[0]?.symbol!==row.symbol)
   throw Error(`Invalid separate risk manifest for ${row.symbol}`);
  env.RISK_MANIFEST_JSON=JSON.stringify(manifest);
 }
 if(kind==='alerts'&&!env.ALERTS_START_DELAY_MS)env.ALERTS_START_DELAY_MS=String(index*1800);
 if(kind==='keeper'&&!env.KEEPER_ALERT_LABEL)env.KEEPER_ALERT_LABEL=`${row.symbol} keeper`;
 return env;
}
