import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtempSync,mkdirSync,cpSync,writeFileSync,readFileSync,symlinkSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
function fixture(t){
  const root=mkdtempSync(join(tmpdir(),'turret-standby-')),cwd=join(root,'services/staking-collector');
  mkdirSync(cwd,{recursive:true});mkdirSync(join(root,'services/liquidator/src'),{recursive:true});
  cpSync(new URL('../src',import.meta.url),join(cwd,'src'),{recursive:true});
  cpSync(new URL('../config',import.meta.url),join(cwd,'config'),{recursive:true});
  cpSync(new URL('../../liquidator/src/store.mjs',import.meta.url),join(root,'services/liquidator/src/store.mjs'));
  symlinkSync(fileURLToPath(new URL('../node_modules',import.meta.url)),join(cwd,'node_modules'));
  const path=join(cwd,'config/deployment.json'),manifest=JSON.parse(readFileSync(path,'utf8'));
  manifest.deployment=null;writeFileSync(path,JSON.stringify(manifest));
  t.after(()=>rmSync(root,{recursive:true,force:true}));return cwd;
}
test('undeployed worker starts in observation without any signing key or RPC',async t=>{
  const child=spawn(process.execPath,['src/main.mjs'],{cwd:fixture(t),env:{PATH:process.env.PATH,PORT:'18675',COLLECTOR_MODE:'observe'},stdio:['ignore','pipe','pipe']});
  t.after(()=>child.kill('SIGTERM'));
  await Promise.race([once(child.stdout,'data'),once(child,'exit').then(()=>{throw Error('worker_failed');}),new Promise((_,reject)=>setTimeout(()=>reject(Error('timeout')),10000).unref())]);
  const status=await(await fetch('http://127.0.0.1:18675/status')).json();
  assert.deepEqual(status,{alive:true,mode:'observe',reason:'awaiting_verified_deployment'});
  assert.equal((await fetch('http://127.0.0.1:18675/unknown')).status,404);
});
test('undeployed worker refuses execute mode',async t=>{
  const child=spawn(process.execPath,['src/main.mjs'],{cwd:fixture(t),env:{PATH:process.env.PATH,COLLECTOR_MODE:'execute'},stdio:'ignore'});
  assert.equal((await once(child,'exit'))[0],1);
});
