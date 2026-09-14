import {sessionKinds} from './calendar.mjs';
import {extendedSessionConfig} from './extended-sessions.mjs';

export function sessionConfig(manifest,mode,regularFeed='iex'){
 const policy=manifest.tradingSessionPolicy??'regular';
 const continuous=extendedSessionConfig(manifest);
 if(!['regular','equities-24x5'].includes(policy)||!['iex','sip'].includes(regularFeed))throw new Error('InvalidSessionConfiguration');
 // A previous regular-hours qualification cannot silently authorize overnight
 // execution. These operator attestations supplement, never replace, live checks.
 if(policy==='equities-24x5'&&mode==='execute'&&(manifest.marketDataUseApproved!==true
  ||!manifest.markets?.length||manifest.markets.some(m=>!sessionKinds.every(k=>
   m.sessionDataVerified?.[k]===feedForSession({open:true,kind:k},{policy,regularFeed})
    ||continuous&&k!=='regular'))))throw new Error('SessionQualificationMissing');
 return {policy,regularFeed,...(continuous?{continuous}: {})};
}

export function feedForSession(session,{policy,regularFeed}){
 if(!session.open)return null;
 if(policy==='regular'||session.kind==='regular')return regularFeed;
 if(session.kind==='overnight')return 'boats';
 if(['premarket','postmarket'].includes(session.kind))return 'sip';
 throw new Error('InvalidTradingSession');
}
