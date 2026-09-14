// Source: https://www.nyse.com/trade/hours-calendars (verified 2026-09-05).
// Explicit published dates, not inferred holiday formulas. Extended sessions
// still require their configured venue's fresh live data and admission checks.
const reviewedYears=new Set(['2026','2027','2028']);
const holidays=new Set([
 '2026-01-01','2026-01-19','2026-02-16','2026-04-03','2026-05-25','2026-06-19','2026-07-03','2026-09-07','2026-11-26','2026-12-25',
 '2027-01-01','2027-01-18','2027-02-15','2027-03-26','2027-05-31','2027-06-18','2027-07-05','2027-09-06','2027-11-25','2027-12-24',
 // NYSE does not observe Jan 1, 2028 (Saturday) on Dec 31, 2027.
 '2028-01-17','2028-02-21','2028-04-14','2028-05-29','2028-06-19','2028-07-04','2028-09-04','2028-11-23','2028-12-25',
]);
const earlyCloses=new Set(['2026-11-27','2026-12-24','2027-11-26','2028-07-03','2028-11-24']);
// At 20:00 ET the overnight trading date advances into the unreviewed year.
const expiresAt=Date.parse('2029-01-01T01:00:00Z')/1000;
export function calendarStatus(now) {
 if(!Number.isSafeInteger(now))throw new Error('InvalidSessionTime');
 const daysRemaining=Math.max(0,Math.ceil((expiresAt-now)/86400));
 return {reviewedThrough:'2028-12-31',expiresAt,daysRemaining,expiring:daysRemaining<=90,expired:now>=expiresAt};
}
const formatter=new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23',weekday:'short'});
export const sessionKinds=['overnight','premarket','regular','postmarket'];
export function sessionAt(now,policy='regular') {
 if(!['regular','equities-24x5'].includes(policy))throw new Error('InvalidSessionPolicy');
 if(!Number.isSafeInteger(now))throw new Error('InvalidSessionTime');
 const d=Object.fromEntries(formatter.formatToParts(new Date(now*1000)).map(p=>[p.type,p.value]));
 const date=`${d.year}-${d.month}-${d.day}`;
 if(!reviewedYears.has(d.year))return {open:false,reason:'calendar_expired'};
 const seconds=Number(d.hour)*3600+Number(d.minute)*60+Number(d.second),midnight=now-seconds;
 if(policy==='equities-24x5'){
  // The 20:00–04:00 ET session belongs to the following trading date.
  // DST changes occur on closed Sunday mornings, never inside this window.
  const nextDay=seconds>=20*3600;
  const tradeDate=nextDay?new Date(Date.parse(`${date}T00:00:00Z`)+86400000).toISOString().slice(0,10):date;
  if(!reviewedYears.has(tradeDate.slice(0,4)))return {open:false,reason:'calendar_expired'};
  const weekday=new Date(`${tradeDate}T00:00:00Z`).getUTCDay();
  if(weekday===0||weekday===6||holidays.has(tradeDate))return {open:false,reason:'market_closed',tradeDate};
  let kind,sessionOpen,sessionClose;
  if(nextDay||seconds<4*3600){
   kind='overnight';sessionOpen=midnight+(nextDay?20:-4)*3600;sessionClose=sessionOpen+8*3600;
  }else if(seconds<9*3600+30*60){
   kind='premarket';sessionOpen=midnight+4*3600;sessionClose=midnight+9*3600+30*60;
  }else if(seconds<(earlyCloses.has(tradeDate)?13:16)*3600){
   kind='regular';sessionOpen=midnight+9*3600+30*60;sessionClose=midnight+(earlyCloses.has(tradeDate)?13:16)*3600;
  }else{
   // Conservatively exclude half-day postmarket until its venue schedule is reviewed.
   if(earlyCloses.has(tradeDate))return {open:false,reason:'market_closed',tradeDate};
   kind='postmarket';sessionOpen=midnight+16*3600;sessionClose=midnight+20*3600;
  }
  return {open:true,kind,tradeDate,sessionOpen,sessionClose};
 }
 if(['Sat','Sun'].includes(d.weekday)||holidays.has(date))return {open:false,reason:'market_closed'};
 // Avoid opening/closing auctions: 09:35 to 15:50 ET, or 12:50 on half days.
 const sessionOpen=midnight+9*3600+35*60,sessionClose=midnight+(earlyCloses.has(date)?12:15)*3600+50*60;
 return {open:now>=sessionOpen&&now<sessionClose,reason:'market_closed',kind:'regular',tradeDate:date,sessionOpen,sessionClose};
}

export function nextSessionOpen(now,policy='regular') {
 if(!Number.isSafeInteger(now))throw new Error('InvalidSessionTime');
 // Both supported policies open on five-minute boundaries. Walk a bounded,
 // normalized schedule so callers receive the exact opening timestamp even
 // when the request arrives between boundaries.
 const end=now+8*86400;
 for(let candidate=Math.floor(now/300)*300+300;candidate<=end;candidate+=300){
  const session=sessionAt(candidate,policy);
  if(session.reason==='calendar_expired')return null;
  if(session.open)return session.sessionOpen;
 }
 return null;
}
