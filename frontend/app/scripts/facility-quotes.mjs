import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { assessQuote, isAccount, parseSignedQuote, quoteDigest, summarizeFacilities } from "../src/facilities/quotes.mjs";
import { readFacilityQuotes, validateFacilityEntry } from "../src/facilities/reader.mjs";

export class QuoteBoardError extends Error {
  constructor(status,message){super(message);this.status=status;}
}
const fail=(status,message)=>{throw new QuoteBoardError(status,message);};
const seconds=ms=>{
  if(!Number.isSafeInteger(ms)||ms<0)throw new Error("Invalid quote board clock.");
  return Math.floor(ms/1000);
};
export const MAX_QUOTE_BYTES=16_384;
export const MAX_LISTING_SECONDS=86_400;
function listing(value,now) {
  if(Buffer.byteLength(JSON.stringify(value)??"")>MAX_QUOTE_BYTES)fail(413,"Quote is too large.");
  let envelope;try{envelope=parseSignedQuote(value);}catch{fail(400,"Invalid signed quote.");}
  const expiry=Number(envelope.quote.expiresAt);
  if(expiry<=now)fail(409,"Quote has expired.");
  if(expiry>now+MAX_LISTING_SECONDS)fail(400,"Publish quotes expiring within the next 24 hours.");
  return envelope;
}

/** One database on a durable local volume. WAL supports concurrent processes on that volume.
 * It is not a replicated store: multiple Railway replicas need a shared database implementation.
 */
export function openFacilityQuoteStore(path,{maxQuotes=2000,maxPerFacility=100}={}) {
  if(!isAbsolute(path)||!Number.isInteger(maxQuotes)||maxQuotes<1||maxQuotes>10000
    ||!Number.isInteger(maxPerFacility)||maxPerFacility<1||maxPerFacility>100)throw new Error("Invalid quote store configuration.");
  mkdirSync(dirname(path),{recursive:true,mode:0o700});
  const db=new DatabaseSync(path,{timeout:3000});
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
    CREATE TABLE IF NOT EXISTS facility_quotes (
      id TEXT PRIMARY KEY, chain_id INTEGER NOT NULL, facility TEXT NOT NULL,
      epoch TEXT NOT NULL, nonce TEXT NOT NULL, expires_at INTEGER NOT NULL,
      payload TEXT NOT NULL, UNIQUE(chain_id,facility,epoch,nonce));
    CREATE INDEX IF NOT EXISTS facility_quotes_expiry ON facility_quotes(expires_at);`);
  const prune=db.prepare("DELETE FROM facility_quotes WHERE expires_at <= ?");
  const nonce=db.prepare("SELECT id FROM facility_quotes WHERE chain_id=? AND facility=? AND epoch=? AND nonce=?");
  const count=db.prepare("SELECT count(*) AS total FROM facility_quotes");
  const facilityCount=db.prepare("SELECT count(*) AS total FROM facility_quotes WHERE chain_id=? AND facility=?");
  const put=db.prepare(`INSERT INTO facility_quotes(id,chain_id,facility,epoch,nonce,expires_at,payload) VALUES(?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET payload=excluded.payload`);
  const list=db.prepare("SELECT payload FROM facility_quotes WHERE chain_id=? AND facility=? AND expires_at>? ORDER BY id");
  return {
    put(value,nowMs) {
      const now=seconds(nowMs),e=listing(value,now),id=quoteDigest(e);
      db.exec("BEGIN IMMEDIATE");
      try {
        prune.run(now);
        const existing=nonce.get(e.chainId,e.facility,e.quote.epoch,e.quote.nonce);
        if(existing&&existing.id!==id)fail(409,"This quote number already has different signed terms. Use a new nonce.");
        if(!existing&&(count.get().total>=maxQuotes||facilityCount.get(e.chainId,e.facility).total>=maxPerFacility))fail(429,"Quote directory capacity reached. Retry after older quotes expire.");
        put.run(id,e.chainId,e.facility,e.quote.epoch,e.quote.nonce,Number(e.quote.expiresAt),JSON.stringify(e));
        db.exec("COMMIT");return {id,envelope:e};
      }catch(error){db.exec("ROLLBACK");throw error;}
    },
    list(chainId,facility,nowMs) {
      if(!Number.isSafeInteger(chainId)||chainId<=0||!isAccount(facility))fail(400,"Invalid facility.");
      return list.all(chainId,facility.toLowerCase(),seconds(nowMs)).map(row=>parseSignedQuote(JSON.parse(row.payload)));
    },
    close(){db.close();},
  };
}

/** Signed quotes are authorizations to draw capital, not mere advertisements.
 * Any relay may publish them. Each submission and every listing rechecks current on-chain authority.
 */
export function createFacilityQuoteBoard({entries,baseline,client,store,clock=Date.now,read=readFacilityQuotes,resolveEntry}) {
  if(!Array.isArray(entries)||entries.length>100)throw new Error("Invalid facility registry.");
  const registry=new Map();
  for(const entry of entries) {
    validateFacilityEntry(entry,baseline);
    const key=`${entry.chainId}:${entry.address.toLowerCase()}`;
    if(registry.has(key))throw new Error("Duplicate admitted facility.");
    registry.set(key,structuredClone(entry));
  }
  const qualification=structuredClone(baseline);
  let activeReads=0;
  const admitted=async(chainId,address)=>{
    if(!Number.isSafeInteger(chainId)||!isAccount(address))fail(400,"Invalid facility.");
    const entry=registry.get(`${chainId}:${address.toLowerCase()}`) ?? (resolveEntry ? await resolveEntry(chainId,address) : null);
    if(!entry)fail(404,"This facility is not admitted to the directory.");
    return entry;
  };
  const inspect=async(entry,envelopes)=>{
    if(activeReads>=4)fail(429,"Quote checks are busy. Retry shortly.");
    activeReads++;
    try {return await read(client,entry,qualification,envelopes,{clock});}
    catch{fail(503,"Current facility and signature checks are unavailable. Retry shortly.");}
    finally{activeReads--;}
  };
  return {
    async submit(value) {
      const envelope=listing(value,seconds(clock()));
      const entry=await admitted(envelope.chainId,envelope.facility);
      const snapshot=await inspect(entry,[envelope]);
      const availability=assessQuote(envelope,snapshot.rows[0]?.observation,{now:clock()});
      if(["invalid","revoked","expired","filled"].includes(availability.status))fail(409,availability.reason);
      if(availability.status==="unavailable")fail(503,availability.reason);
      const saved=store.put(envelope,clock());
      return {...saved,availability,checkedAt:snapshot.checkedAt,block:snapshot.block};
    },
    async list({chainId,facility,account}={}) {
      const entry=await admitted(chainId,facility);
      if(account!==undefined&&!isAccount(account))fail(400,"Invalid borrower address.");
      const envelopes=store.list(chainId,facility,clock());
      const snapshot=await inspect(entry,envelopes);
      const groups=summarizeFacilities(snapshot.rows,{now:clock(),account});
      if(groups.some(group=>group.status==="unavailable"))fail(503,"Current facility capacity could not be verified.");
      // Private means an on-chain borrower restriction, not secret terms or authenticated access.
      const group=groups[0];
      return {chainId,facility:entry.address,checkedAt:snapshot.checkedAt,block:snapshot.block,
        status:"checked",capacity:group?.capacity??0n,
        quotes:(group?.quotes??[]).filter(q=>q.availability.status==="available"&&q.availability.borrowerEligible)};
    },
  };
}

/** Framework-neutral handler; explicit origin and bounded body. No cross-origin POST permission. */
export function createFacilityQuotesHandler({board,origin}) {
  if(new URL(origin).origin!==origin)throw new Error("Configure one exact quote board origin.");
  return async request=>{
    const json=(status,value)=>new Response(JSON.stringify(value,(_,v)=>typeof v==="bigint"?v.toString():v),{
      status,headers:{"content-type":"application/json","cache-control":"no-store","x-content-type-options":"nosniff"},
    });
    try {
      const url=new URL(request.url);
      if(request.method==="GET") {
        const keys=[...url.searchParams.keys()];
        if(keys.some(k=>!["chainId","facility","account"].includes(k))||new Set(keys).size!==keys.length)fail(400,"Invalid query parameters.");
        const chainId=url.searchParams.get("chainId");
        if(!/^[1-9][0-9]{0,15}$/.test(chainId??""))fail(400,"Invalid chain ID.");
        return json(200,await board.list({chainId:Number(chainId),facility:url.searchParams.get("facility"),account:url.searchParams.get("account")??undefined}));
      }
      if(request.method!=="POST")return json(405,{error:"Use GET or POST."});
      if(request.headers.get("origin")!==origin)fail(403,"Publish from the configured website origin.");
      if(request.headers.get("content-type")?.split(";")[0].trim()!=="application/json")fail(415,"Send application/json.");
      if(Number(request.headers.get("content-length"))>MAX_QUOTE_BYTES)fail(413,"Quote is too large.");
      const reader=request.body?.getReader();if(!reader)fail(400,"A signed quote is required.");
      let size=0;const parts=[];
      try {
        for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;
          if(size>MAX_QUOTE_BYTES){await reader.cancel();fail(413,"Quote is too large.");}parts.push(value);}
      }finally{reader.releaseLock();}
      let payload;try{payload=JSON.parse(Buffer.concat(parts).toString("utf8"));}catch{fail(400,"Invalid JSON.");}
      return json(200,await board.submit(payload));
    }catch(error){return json(error instanceof QuoteBoardError?error.status:503,{error:error instanceof QuoteBoardError?error.message:"Quote directory is temporarily unavailable."});}
  };
}
