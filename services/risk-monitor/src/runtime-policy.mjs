const integer=(env,name,defaultValue,min,max)=>{
 const value=Number(env[name]??defaultValue);
 if(!Number.isSafeInteger(value)||value<min||value>max)throw new Error(`Invalid ${name}`);
 return value;
};

export function riskRuntimePolicy(env={},executionGate=false){
 return {
  requiredHealthyProviders:integer(env,'RISK_MIN_HEALTHY_RPC_PROVIDERS',2,1,2),
  pollMs:integer(env,'RISK_POLL_MS',executionGate?5000:15000,1000,25000),
  deploymentVerifyIntervalMs:integer(env,'RISK_DEPLOYMENT_VERIFY_INTERVAL_MS',60000,10000,3600000),
 };
}
