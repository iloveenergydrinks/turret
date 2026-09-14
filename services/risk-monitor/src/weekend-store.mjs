import {DatabaseSync} from 'node:sqlite';
import {mkdirSync,chmodSync} from 'node:fs';
import {join} from 'node:path';

// Separate journal: observation data never enters the keeper/admission stores.
export class WeekendStore {
 constructor(directory,engine){
  if(directory!==':memory:')mkdirSync(directory,{recursive:true,mode:0o700});
  const file=directory===':memory:'?directory:join(directory,'observations.sqlite');
  this.db=new DatabaseSync(file);
  if(directory!==':memory:')chmodSync(file,0o600);
  this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=1000; CREATE TABLE IF NOT EXISTS identity(engine TEXT NOT NULL); CREATE TABLE IF NOT EXISTS samples(at INTEGER PRIMARY KEY, complete INTEGER NOT NULL, value TEXT NOT NULL);');
  const previous=this.db.prepare('SELECT engine FROM identity').get();
  if(previous&&previous.engine!==engine.toLowerCase()){this.db.close();throw new Error('WeekendJournalIdentityMismatch');}
  if(!previous)this.db.prepare('INSERT INTO identity VALUES (?)').run(engine.toLowerCase());
 }
 save(sample){
  const value=JSON.stringify(sample);
  if(!Number.isSafeInteger(sample.checkedAt)||value.length>65536)throw new Error('InvalidWeekendSample');
  this.db.prepare('INSERT OR REPLACE INTO samples VALUES (?,?,?)').run(sample.checkedAt,Number(sample.observationComplete===true),value);
  // Keep up to fourteen days at a one-minute cadence, also bounded by row count.
  this.db.prepare('DELETE FROM samples WHERE at<?').run(sample.checkedAt-14*86400);
  this.db.exec('DELETE FROM samples WHERE at NOT IN (SELECT at FROM samples ORDER BY at DESC LIMIT 20160)');
 }
 recent(limit=60){return this.db.prepare('SELECT value FROM samples ORDER BY at DESC LIMIT ?').all(Math.max(1,Math.min(120,limit))).map(r=>JSON.parse(r.value));}
 summary(){return this.db.prepare('SELECT count(*) AS samples,coalesce(sum(complete),0) AS completeSamples,min(at) AS firstAt,max(at) AS lastAt FROM samples').get();}
 close(){this.db.close();}
}
