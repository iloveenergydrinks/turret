import {DatabaseSync} from 'node:sqlite';
import {parseAbi} from 'viem';
import {factoryAbi,verifyFactory,validateFactoryConfig} from '../src/facilities/factory.mjs';
import {isAccount,same,ZERO_ADDRESS} from '../src/facilities/quotes.mjs';
const loanEvent=parseAbi(['event LoanOpened(uint256 indexed id,address indexed borrower,bytes32 indexed quoteDigest,uint256 principal,uint256 collateralAmount,uint256 interest,uint256 dueAt,address vault)'])[0];
const hash=value=>typeof value==='string'&&/^0x[0-9a-f]{64}$/i.test(value);
const fail=(message,status=503)=>Object.assign(Error(message),{status});
const key=value=>BigInt(value).toString().padStart(78,'0');
/** Wallet discovery uses indexed borrower events and factory-owned lender mappings.
 * It never requires the user to remember a facility address or trust browser storage.
 */
export function createStandingAccountIndex({config,client,directory,databasePath,pageBlocks=10000n,maxPages=4,maxAccounts=10000}) {
 validateFactoryConfig(config);
 if(!Number.isInteger(maxAccounts)||maxAccounts<1||maxAccounts>10000)throw Error('Invalid account cache capacity.');
 if(typeof pageBlocks!=='bigint'||pageBlocks<1n||pageBlocks>100000n||!Number.isInteger(maxPages)||maxPages<1||maxPages>16)throw Error('Invalid account history configuration.');
 const binding=JSON.stringify([config.chainId,config.factory.toLowerCase(),config.runtimeHash.toLowerCase(),config.startBlock]);
 const db=new DatabaseSync(databasePath,{timeout:3000});
 db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
 CREATE TABLE IF NOT EXISTS standing_account_meta(binding TEXT NOT NULL,account TEXT NOT NULL,epoch INTEGER NOT NULL,checkpoints TEXT NOT NULL,PRIMARY KEY(binding,account));
 CREATE TABLE IF NOT EXISTS standing_account_loans(binding TEXT NOT NULL,account TEXT NOT NULL,facility TEXT NOT NULL,opened_block TEXT NOT NULL,tx TEXT NOT NULL,log_index INTEGER NOT NULL,PRIMARY KEY(binding,account,tx,log_index));
 CREATE INDEX IF NOT EXISTS standing_account_balances ON standing_account_loans(binding,account,facility);
 CREATE INDEX IF NOT EXISTS standing_account_blocks ON standing_account_loans(binding,account,opened_block);`);
 // This is a reconstructible chain-history cache. Evict cold wallets instead of
 // letting anonymous queries permanently exhaust discovery for new borrowers.
 if(!db.prepare('PRAGMA table_info(standing_account_meta)').all().some(c=>c.name==='touched'))db.exec('ALTER TABLE standing_account_meta ADD COLUMN touched INTEGER NOT NULL DEFAULT 0');
 db.exec(`CREATE TABLE IF NOT EXISTS standing_account_generation(id INTEGER PRIMARY KEY CHECK(id=1),value INTEGER NOT NULL);
 INSERT OR IGNORE INTO standing_account_generation SELECT 1,COALESCE(MAX(epoch),0) FROM standing_account_meta;`);
 const pending=new Map();let active=0;
 const canonical=async number=>{const block=await client.getBlock({blockNumber:number});if(block.number!==number||!hash(block.hash))throw fail('Invalid canonical account history block.');return block;};
 async function perform(account) {
  const target=await verifyFactory(client,config),start=BigInt(config.startBlock);
  const saved=db.prepare('SELECT * FROM standing_account_meta WHERE binding=? AND account=?').get(binding,account);
  const old=saved?JSON.parse(saved.checkpoints):[];
  if(!Array.isArray(old)||old.length>16||old.some((p,i)=>!/^\d+$/.test(p.number)||!hash(p.hash)||BigInt(p.number)<start||i>0&&BigInt(p.number)<=BigInt(old[i-1].number)))throw fail('Saved account history is invalid.');
  let selected=-1;
  for(let i=old.length-1;i>=0;i--)if(BigInt(old[i].number)<=target.number&&same((await canonical(BigInt(old[i].number))).hash,old[i].hash)){selected=i;break;}
  const checkpoints=old.slice(0,selected+1),rewind=checkpoints.length?BigInt(checkpoints.at(-1).number):start-1n;
  let through=rewind;const discovered=[],origins=new Map();
  for(let page=0;page<maxPages&&through<target.number;page++){
   const from=through+1n,to=from+pageBlocks-1n<target.number?from+pageBlocks-1n:target.number;
   const end=await canonical(to),logs=await client.getLogs({event:loanEvent,args:{borrower:account},strict:true,fromBlock:from,toBlock:to});
   if(!Array.isArray(logs)||logs.length>5000)throw fail('Account loan event page is too large.');
   const seen=new Set(),blocks=new Map();
   for(const log of logs){
    if(!isAccount(log.address)||!same(log.args?.borrower,account)||typeof log.args.id!=='bigint'||log.args.id<1n||log.removed
     ||typeof log.blockNumber!=='bigint'||log.blockNumber<from||log.blockNumber>to||!hash(log.blockHash)||!hash(log.transactionHash)||!Number.isSafeInteger(log.logIndex)||log.logIndex<0)throw fail('Invalid account loan event.');
    const position=`${log.transactionHash}:${log.logIndex}`;if(seen.has(position))throw fail('Duplicate account loan event.');seen.add(position);
    const blockKey=String(log.blockNumber);if(!blocks.has(blockKey))blocks.set(blockKey,(await canonical(log.blockNumber)).hash);
    if(!same(blocks.get(blockKey),log.blockHash))throw fail('Account loan history reorganized during discovery.');
    // Unrelated contracts can emit this event. Only the pinned factory's recorded deployments count.
    const origin=log.address.toLowerCase();
    if(!origins.has(origin))origins.set(origin,await client.readContract({address:config.factory,abi:factoryAbi,functionName:'createdAtBlock',args:[log.address],blockNumber:target.number}));
    const created=origins.get(origin);
    if(created===0n)continue;
    if(typeof created!=='bigint'||created<start||created>log.blockNumber)throw fail('Invalid facility event origin.');
    discovered.push({facility:log.address.toLowerCase(),block:key(log.blockNumber),tx:log.transactionHash.toLowerCase(),index:log.logIndex});
   }
   if(!same((await canonical(to)).hash,end.hash))throw fail('Account history changed during discovery.');
   through=to;checkpoints.push({number:String(to),hash:end.hash});
  }
  // A lender has at most one factory deployment per admitted token. This bound is independent of total users.
  const owned=[];
  for(let offset=0;offset<config.collateral.length;offset+=20){
   const addresses=await Promise.all(config.collateral.slice(offset,offset+20).map(token=>client.readContract({address:config.factory,abi:factoryAbi,functionName:'getFacility',args:[account,token.address],blockNumber:target.number})));
   for(const address of addresses){if(same(address,ZERO_ADDRESS))continue;if(!isAccount(address))throw fail('Invalid lender mapping.');owned.push(address.toLowerCase());}
  }
  if(!same((await canonical(target.number)).hash,target.hash)||Math.abs(Date.now()-Number(target.timestamp)*1000)>=30000)throw fail('Account history checks became stale. Retry.');
  let epoch=saved?.epoch;
  db.exec('BEGIN IMMEDIATE');
  try{
   if(!saved&&db.prepare('SELECT count(*) n FROM standing_account_meta').get().n>=maxAccounts){
    const victim=db.prepare('SELECT binding,account FROM standing_account_meta ORDER BY touched,binding,account').all().find(row=>row.binding!==binding||!pending.has(row.account));
    if(!victim)throw fail('Account history checks are busy. Retry shortly.',429);
    db.prepare('DELETE FROM standing_account_loans WHERE binding=? AND account=?').run(victim.binding,victim.account);
    db.prepare('DELETE FROM standing_account_meta WHERE binding=? AND account=?').run(victim.binding,victim.account);
   }
   if(!saved||selected<old.length-1){
    epoch=db.prepare('UPDATE standing_account_generation SET value=value+1 WHERE id=1 RETURNING value').get().value;
   }
   if(rewind<0n)db.prepare('DELETE FROM standing_account_loans WHERE binding=? AND account=?').run(binding,account);
   else db.prepare('DELETE FROM standing_account_loans WHERE binding=? AND account=? AND opened_block>?').run(binding,account,key(rewind));
   const insert=db.prepare('INSERT OR IGNORE INTO standing_account_loans VALUES(?,?,?,?,?,?)');
   for(const event of discovered)insert.run(binding,account,event.facility,event.block,event.tx,event.index);
   db.prepare('INSERT INTO standing_account_meta(binding,account,epoch,checkpoints,touched) VALUES(?,?,?,?,?) ON CONFLICT(binding,account) DO UPDATE SET epoch=excluded.epoch,checkpoints=excluded.checkpoints,touched=excluded.touched').run(binding,account,epoch,JSON.stringify(checkpoints.slice(-16)),Date.now());
   db.exec('COMMIT');
  }catch(error){db.exec('ROLLBACK');throw error;}
  const borrowed=db.prepare('SELECT DISTINCT facility FROM standing_account_loans WHERE binding=? AND account=?').all(binding,account).map(r=>r.facility);
  return {addresses:[...new Set([...borrowed,...owned])].sort(),complete:through===target.number,indexedThrough:String(through),blockNumber:String(target.number),blockHash:target.hash,historyEpoch:epoch,checkedAt:Date.now()};
 }
 async function sync(account){
  if(pending.has(account))return pending.get(account);if(active>=2)throw fail('Account history checks are busy. Retry shortly.',429);
  active++;const task=perform(account).finally(()=>{active--;pending.delete(account);});pending.set(account,task);return task;
 }
 async function list({account,after,epoch}){
  if(!isAccount(account)||after!==undefined&&!isAccount(after)||epoch!==undefined&&!/^(0|[1-9][0-9]{0,9})$/.test(epoch))throw fail('Invalid account history query.',400);
  account=account.toLowerCase();const snapshot=await sync(account);
  if(epoch!==undefined&&Number(epoch)!==snapshot.historyEpoch)throw fail('Account history changed. Reload from the first page.',409);
  const candidates=snapshot.addresses.filter(a=>!after||a>after.toLowerCase());
  const entries=[];for(let i=0;i<Math.min(12,candidates.length);i+=2)entries.push(...await Promise.all(candidates.slice(i,Math.min(i+2,12)).map(address=>directory.admitRecovery(address))));
  const {addresses,...progress}=snapshot;
  if(Date.now()-snapshot.checkedAt>=30000||!same((await canonical(BigInt(snapshot.blockNumber))).hash,snapshot.blockHash))throw fail('Account history changed before delivery. Retry.');
  return {schemaVersion:1,chainId:config.chainId,account,...progress,entries,nextCursor:candidates.length>12?candidates[11]:null};
 }
 async function mount(req,res,headers={}){
  const url=new URL(req.url||'/','http://localhost');if(url.pathname!=='/api/standing-account')return false;
  try{
   const keys=[...url.searchParams.keys()];if(req.method!=='GET'||keys.some(k=>!['account','after','epoch'].includes(k))||new Set(keys).size!==keys.length)throw fail('Use a GET account history query.',400);
   const data=await list(Object.fromEntries(url.searchParams));res.writeHead(200,{...headers,'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(data));
  }catch(error){if(!res.headersSent&&!res.destroyed){res.writeHead(error.status??503,{...headers,'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify({error:error.status?error.message:'Standing loan history could not be verified. Retry shortly.'}));}}
  req.resume();return true;
 }
 return {list,mount,close:()=>db.close()};
}
