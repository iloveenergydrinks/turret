import {spawn} from 'node:child_process';
import {createServer,request} from 'node:http';
import {dirname} from 'node:path';
import {mkdirSync} from 'node:fs';
import {childEnvironment} from './child-env.mjs';

const definitions={
 risk:{entry:'services/risk-monitor/src/main.mjs',basePort:10000},
 keeper:{entry:'services/liquidator/src/isolated/main.mjs',basePort:10100},
 alerts:{entry:'services/borrower-alerts/src/server.mjs',basePort:10200},
};
const kind=process.env.EXPANSION_KIND,definition=definitions[kind];
let rows;
try{rows=JSON.parse(process.env.EXPANSION_CONFIG_JSON??'');}catch{}
if(!definition||!Array.isArray(rows)||rows.length<1||rows.length>10)throw Error('Invalid expansion supervisor configuration');
const symbols=new Set(),children=new Map();
for(const [index,row] of rows.entries()){
 if(!/^[A-Z]{1,8}$/.test(row?.symbol??'')||symbols.has(row.symbol)||!row.env||typeof row.env!=='object'||Array.isArray(row.env))throw Error('Invalid expansion child');
 symbols.add(row.symbol);const port=definition.basePort+index;
 const env=childEnvironment(process.env,row,port,kind,index);
 const dataPath=kind==='alerts'?dirname(env.ALERTS_DB_PATH):kind==='risk'?env.RISK_DATA_DIR:env.KEEPER_DATA_DIR;
 mkdirSync(dataPath,{recursive:true,mode:0o700});
 const child=spawn(process.execPath,[definition.entry],{cwd:'/app',env,stdio:'inherit'});
 children.set(row.symbol,{child,port});
 child.once('exit',(code,signal)=>{if(!stopping){console.error(JSON.stringify({level:'error',event:'expansion_child_exit',kind,symbol:row.symbol,code,signal}));process.exit(1);}});
}
const fetchHealth=({port})=>new Promise(resolve=>{
 // Railway needs process liveness here. Each child keeps its stricter readiness
 // response on the market-prefixed route for commissioning and watchdogs.
 const req=request({host:'127.0.0.1',port,path:'/healthz',method:'GET',timeout:3000},res=>{res.resume();resolve(Boolean(res.statusCode));});
 req.on('error',()=>resolve(false));req.on('timeout',()=>{req.destroy();resolve(false);});req.end();
});
const server=createServer(async(req,res)=>{
 const url=new URL(req.url??'/','http://localhost');
 if(url.pathname==='/healthz'){
  const states=await Promise.all([...children.values()].map(fetchHealth)),ready=states.every(Boolean);
  res.writeHead(ready?200:503,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify({alive:true,ready,children:states.filter(Boolean).length,total:states.length}));return;
 }
 const match=/^\/([A-Z]{1,8})(\/.*)?$/.exec(url.pathname),target=match&&children.get(match[1]);
 if(!target){res.writeHead(404,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end('{}');return;}
 const headers={...req.headers,host:`127.0.0.1:${target.port}`};
 const upstream=request({host:'127.0.0.1',port:target.port,path:`${match[2]||'/'}${url.search}`,method:req.method,headers,timeout:20000},response=>{
  res.writeHead(response.statusCode??502,response.headers);response.pipe(res);
 });
 upstream.on('timeout',()=>upstream.destroy(new Error('timeout')));
 upstream.on('error',()=>{if(!res.headersSent)res.writeHead(502,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end('{}');});
 req.pipe(upstream);
});
server.listen(Number(process.env.PORT??8080),'::');
let stopping=false;
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>{stopping=true;for(const {child} of children.values())child.kill(signal);server.close(()=>process.exit(0));setTimeout(()=>process.exit(1),20000).unref();});
