const progressing=new Set(['waiting_for_hour_balance_or_allowance','pending','confirming','confirmed']);
const safeErrors=new Set(['wrong_chain','rpc_disagreement_or_stale','module_configuration_changed','runtime_changed','USDG_implementation_changed','reorg','quote_unavailable','quote_rate_limited','no_route','quote_too_large','router_mismatch','build_mismatch','quote_expiring','below_trade_threshold','price_impact_exceeds_one_percent','no_size_within_price_impact_limit','quote_amount_outside_budget','receipt_identity_mismatch','burn_receipt_mismatch']);
export function failureResult(error){return {reason:'checks_failed_execution_paused',errorCode:safeErrors.has(error?.message)?error.message:'verification_or_simulation_failed'};}
export function workerStatus(mode,result,now=Date.now()){
 return {mode,reason:result.reason,operational:mode==='execute'&&progressing.has(result.reason),...(result.errorCode?{errorCode:result.errorCode}:{}),...(result.nextRetryAt?{nextRetryAt:new Date(result.nextRetryAt).toISOString()}:{}),...(result.hash?{hash:result.hash}:{}),checkedAt:new Date(now).toISOString()};
}
