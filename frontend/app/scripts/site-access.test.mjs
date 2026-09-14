import assert from "node:assert/strict";
import {test} from "node:test";
import {createServer} from "node:http";
import {createSiteAccess,hashSitePassword} from "./site-access.mjs";
const password="fixture-password-only";
const passwordHash=await hashSitePassword(password);
const signingKey="ab".repeat(32);
async function setup(options={}) {
 const access=createSiteAccess({enabled:true,passwordHash,signingKey,...options});
 const server=createServer(async(req,res)=>{if(await access(req,res))return;res.writeHead(200,{"Cache-Control":"public, max-age=31536000"});res.end("PRIVATE CONTENT")});
 await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
 const origin=`http://127.0.0.1:${server.address().port}`;
 return {origin,close:()=>new Promise(resolve=>server.close(resolve)),get:(path,options)=>fetch(origin+path,{redirect:"manual",...options}),login:(value=password,next="/borrow",headers={})=>fetch(origin+"/__access/login",{method:"POST",redirect:"manual",headers:{"Content-Type":"application/x-www-form-urlencoded",...headers},body:new URLSearchParams({password:value,next})})};
}
test("direct pages, exports, bundles and APIs cannot bypass the password",async()=>{
 const s=await setup();try{
  for(const path of ["/","/borrow","/earn","/blog/turret-token-and-trading-fees","/blog/feed.xml","/agent-brief.md","/_next/static/app.js","/%62orrow.html","/borrow.txt"]){const r=await s.get(path);const body=await r.text();assert.ok(body.includes("Coming soon"));assert.ok(!body.includes("PRIVATE CONTENT")&&!body.includes(password));assert.equal(r.headers.get("cache-control"),"private, no-store")}
  const r=await s.get('/api/rpc',{method:'POST',body:'{}'});assert.equal(r.status,401);assert.ok(!(await r.text()).includes('PRIVATE CONTENT'));
  assert.equal((await s.get('/robots.txt')).headers.get('x-robots-tag'),'noindex, nofollow');
 }finally{await s.close()}
});
test("correct password creates a secure session; bad passwords and forged cookies fail",async()=>{
 const s=await setup();try{
  const bad=await s.login('incorrect');assert.equal(bad.status,401);assert.ok((await bad.text()).includes('That password is incorrect'));assert.equal(bad.headers.get('set-cookie'),null);
  const ok=await s.login();assert.equal(ok.status,303);assert.equal(ok.headers.get('location'),'/borrow');const cookie=ok.headers.get('set-cookie');assert.match(cookie,/HttpOnly/);assert.match(cookie,/Secure/);assert.match(cookie,/SameSite=Lax/);
  const r=await s.get('/borrow',{headers:{Cookie:cookie.split(';')[0]}});assert.equal(await r.text(),'PRIVATE CONTENT');assert.equal(r.headers.get('cache-control'),'private, no-store');
  const forged=cookie.split(';')[0].replace(/.$/,c=>c==='a'?'b':'a');assert.ok((await(await s.get('/borrow',{headers:{Cookie:forged}})).text()).includes('Coming soon'));
  const logout=await s.get('/__access/logout',{method:'POST'});assert.equal(logout.status,303);assert.match(logout.headers.get('set-cookie'),/Max-Age=0/);
 }finally{await s.close()}
});
test("sessions expire and password rotation invalidates old cookies",async()=>{
 let time=Date.now();const s=await setup({now:()=>time});let cookie;
 try{cookie=(await s.login()).headers.get('set-cookie').split(';')[0];time+=8*3600*1000+1000;assert.ok((await(await s.get('/',{headers:{Cookie:cookie}})).text()).includes('Coming soon'))}finally{await s.close()}
 const rotated=await setup({passwordHash:await hashSitePassword('changed')});try{assert.ok((await(await rotated.get('/',{headers:{Cookie:cookie}})).text()).includes('Coming soon'))}finally{await rotated.close()}
});
test("rejects unsafe redirects and cross-origin forms, and limits password attempts",async()=>{
 const s=await setup({maxAttempts:3});try{
  assert.equal((await s.login(password,'//evil.example')).headers.get('location'),'/');
  assert.equal((await s.login(password,'/\\evil.example')).headers.get('location'),'/');
  assert.equal((await s.login(password,'/',{Origin:'https://evil.example'})).status,403);
  await s.login('wrong');const blocked=await s.login();assert.equal(blocked.status,429);assert.equal(blocked.headers.get('retry-after'),'60');
 }finally{await s.close()}
});
test("an enabled gate fails closed without credentials; disabling restores existing routing",async()=>{
 assert.throws(()=>createSiteAccess({enabled:true,passwordHash:'',signingKey:''}),/credentials/);
 const s=await setup({enabled:false});try{assert.equal(await(await s.get('/borrow')).text(),'PRIVATE CONTENT')}finally{await s.close()}
});
