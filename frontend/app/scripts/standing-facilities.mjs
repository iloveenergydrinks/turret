import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import { readFactoryFacility, validateFactoryConfig } from '../src/facilities/factory.mjs';
import { isAccount, same } from '../src/facilities/quotes.mjs';

const failure=(status,message)=>Object.assign(new Error(message),{status});
export function createStandingDirectory({config,client,databasePath,origin,read=readFactoryFacility,clock=Date.now}) {
  validateFactoryConfig(config);
  if(!isAbsolute(databasePath)||new URL(origin).origin!==origin||(config.chainId===31337&&!['localhost','127.0.0.1','[::1]'].includes(new URL(origin).hostname)))throw Error('Invalid standing directory configuration.');
  mkdirSync(dirname(databasePath),{recursive:true,mode:0o700});
  const db=new DatabaseSync(databasePath,{timeout:3000});
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
    CREATE TABLE IF NOT EXISTS standing_facilities(id INTEGER PRIMARY KEY AUTOINCREMENT,address TEXT UNIQUE NOT NULL,lender TEXT NOT NULL,collateral TEXT NOT NULL,binding TEXT NOT NULL,entry TEXT NOT NULL,creation_hash TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS standing_facilities_owner ON standing_facilities(lender,id);
    CREATE INDEX IF NOT EXISTS standing_facilities_asset ON standing_facilities(collateral,id);`);
  const binding=JSON.stringify([config.chainId,config.factory.toLowerCase(),config.runtimeHash.toLowerCase()]);
  const find=db.prepare('SELECT * FROM standing_facilities WHERE address=?');
  const cache=new Map(),pending=new Map();let checking=0,reading=0;
  async function inspect(address,qualify) {
    const key=address.toLowerCase()+':'+qualify;
    if(pending.has(key))return pending.get(key);
    if(checking>=4)throw failure(429,'Lending balance checks are busy. Retry shortly.');
    checking++;
    const task=read(client,config,address,{clock,qualify}).finally(()=>{checking--;pending.delete(key);});pending.set(key,task);return task;
  }
  async function register(address, qualify=true) {
    if(!isAccount(address))throw failure(400,'Enter a valid lending balance address.');
    const verified=await inspect(address,qualify),entry=verified.entry;
    // Existing identities cannot silently change following a reorganization or configuration change.
    const previous=find.get(address.toLowerCase());
    if(previous&&(previous.binding!==binding||!same(previous.creation_hash,verified.creationHash)||previous.entry!==JSON.stringify(entry)))throw failure(409,'Lending balance identity changed. Contact support before republishing.');
    if(!previous){
      db.exec('BEGIN IMMEDIATE');
      try{
        if(db.prepare('SELECT count(*) n FROM standing_facilities').get().n>=10000)throw failure(429,'Lending directory is at capacity.');
        db.prepare('INSERT OR IGNORE INTO standing_facilities(address,lender,collateral,binding,entry,creation_hash) VALUES(?,?,?,?,?,?)').run(entry.address.toLowerCase(),entry.lender.toLowerCase(),entry.collateralToken.toLowerCase(),binding,JSON.stringify(entry),verified.creationHash);
        db.exec('COMMIT');
      }catch(error){db.exec('ROLLBACK');throw error;}
    }
    cache.delete(address.toLowerCase());return entry;
  }
  async function resolveEntry(chainId,address) {
    if(chainId!==config.chainId||!isAccount(address))throw failure(400,'Invalid lending balance.');
    const row=find.get(address.toLowerCase());
    if(!row||row.binding!==binding)throw failure(404,'This lending balance has not been published.');
    const saved=cache.get(row.address);
    if(saved&&clock()-saved.at<10000)return structuredClone(saved.entry);
    const verified=await inspect(address,false);
    if(!same(verified.creationHash,row.creation_hash)||JSON.stringify(verified.entry)!==row.entry)throw failure(503,'Lending balance identity changed. Recovery needs a verified contract.');
    if(cache.size>=128)cache.delete(cache.keys().next().value);
    cache.set(row.address,{entry:verified.entry,at:clock()});return structuredClone(verified.entry);
  }
  function list({after='0',lender,collateral,available=false}={}) {
    if(!/^(0|[1-9][0-9]{0,14})$/.test(after)||lender&&!isAccount(lender)||collateral&&!isAccount(collateral))throw failure(400,'Invalid lending directory filter.');
    const clauses=['f.id>?','f.binding=?'],args=[Number(after),binding];
    if(lender){clauses.push('f.lender=?');args.push(lender.toLowerCase());}
    if(collateral){clauses.push('f.collateral=?');args.push(collateral.toLowerCase());}
    if(available){
      // This is an index of possible offers, never proof of funded availability.
      if(!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='facility_quotes'").get())return {entries:[],nextCursor:null};
      clauses.push('EXISTS (SELECT 1 FROM facility_quotes q WHERE q.facility=f.address AND q.chain_id=? AND q.expires_at>?)');args.push(config.chainId,Math.floor(clock()/1000));
    }
    const rows=db.prepare(`SELECT f.* FROM standing_facilities f WHERE ${clauses.join(' AND ')} ORDER BY f.id LIMIT 13`).all(...args);
    return {entries:rows.slice(0,12).map(r=>JSON.parse(r.entry)),nextCursor:rows.length>12?String(rows[11].id):null};
  }
  const mount=async(req,res,securityHeaders={})=>{
    const url=new URL(req.url||'/',origin);if(url.pathname!=='/api/standing-facilities')return false;
    const send=(status,value)=>{res.writeHead(status,{...securityHeaders,'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(value));};
    try{
      if(req.method==='GET'){
        const keys=[...url.searchParams.keys()];if(keys.some(k=>!['after','lender','collateral','available','facility'].includes(k))||new Set(keys).size!==keys.length)throw failure(400,'Invalid lending directory query.');
        if(url.searchParams.has('facility')){if(keys.length!==1)throw failure(400,'Use a lending balance address alone.');send(200,{entry:await resolveEntry(config.chainId,url.searchParams.get('facility'))});}
        else {
          const p=Object.fromEntries(url.searchParams);if(p.available!==undefined&&p.available!=='1')throw failure(400,'Invalid availability filter.');
          send(200,{schemaVersion:1,...list({...p,available:p.available==='1'})});
        }
      }else if(req.method==='POST'){
        if(req.headers.origin!==origin)throw failure(403,'Publish from the Turret website.');
        if(req.headers['content-type']?.split(';')[0].trim()!=='application/json')throw failure(415,'Use application/json.');
        if(Number(req.headers['content-length'])>512)throw failure(413,'Submission is too large.');
        if(reading>=4)throw failure(429,'Lending balance submissions are busy.');reading++;
        let body;
        try{body=await new Promise((resolve,reject)=>{
          let size=0;const chunks=[];let ended=false;
          const finish=(error)=>{if(ended)return;ended=true;clearTimeout(timer);req.off('data',data);req.off('end',end);req.off('aborted',abort);req.off('error',abort);req.once('error',()=>{});if(error){req.resume();reject(error);}else resolve(Buffer.concat(chunks).toString());};
          const data=c=>{size+=c.length;if(size>512)finish(failure(413,'Submission is too large.'));else chunks.push(c);};const end=()=>finish();const abort=()=>finish(failure(400,'Submission interrupted.'));
          const timer=setTimeout(()=>finish(failure(408,'Submission timed out.')),10000);timer.unref();req.on('data',data);req.once('end',end);req.once('aborted',abort);req.once('error',abort);
        });}finally{reading--;}
        let value;try{value=JSON.parse(body);}catch{throw failure(400,'Invalid JSON.');}
        if(!value||Object.keys(value).length!==1||!isAccount(value.address))throw failure(400,'Submit only the lending balance address.');
        send(200,{entry:await register(value.address)});
      }else throw failure(405,'Use GET or POST.');
    }catch(error){if(!res.destroyed&&!res.headersSent)send(error.status??503,{error:error.status?error.message:'Current lending balance verification is unavailable. Retry shortly.'});}
    finally{req.resume();}return true;
  };
  return {register,admitRecovery:address=>register(address,false),resolveEntry,list,mount,close:()=>db.close()};
}
