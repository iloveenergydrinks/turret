// Exercises a Next static export through the exact production HTTP server.
// No injected wallet, chain writes, or fixture market admission. External
// requests fail closed so this checks routing/hydration, not live data access.
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {createServer} from 'node:net';
import {resolve} from 'node:path';
import {spawn} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import test from 'node:test';

test('stock release routes hydrate, reject unconfigured engines and retain deferred markets', {timeout:180000}, async t => {
  const app=process.env.DOCKYARD_STATIC_APP;
  const runtimePath=process.env.DOCKYARD_PLAYWRIGHT_MODULE;
  const canary=process.env.DOCKYARD_CANARY_ENGINE;
  if(canary)assert.match(canary,/^0x[0-9a-fA-F]{40}$/);
  assert.ok(app && runtimePath, 'Set DOCKYARD_STATIC_APP and DOCKYARD_PLAYWRIGHT_MODULE');
  assert.ok(existsSync(resolve(app,'out/index.html')), 'Build a static export first');
  assert.ok(existsSync(resolve(app,'scripts/serve-mvp.mjs')), 'Use the production server');
  const reservation=createServer();
  await new Promise(r=>reservation.listen(0,'127.0.0.1',r));
  const port=reservation.address().port;
  await new Promise(r=>reservation.close(r));
  const server=spawn(process.execPath,[resolve(app,'scripts/serve-mvp.mjs')],{
    cwd:app,env:{PATH:process.env.PATH,PORT:String(port)},stdio:['ignore','pipe','pipe'],
  });
  let serverError='';
  server.stderr.on('data',chunk=>{serverError=(serverError+chunk).slice(-2000);});
  server.stdout.resume();
  t.after(async()=>{
    if(server.exitCode===null){server.kill('SIGTERM');await new Promise(r=>server.once('exit',r));}
  });
  const origin=`http://127.0.0.1:${port}`;
  for(let attempt=0;attempt<100;attempt++) {
    assert.equal(server.exitCode,null,serverError);
    try {if((await fetch(origin)).status===200)break;}catch{}
    if(attempt===99)assert.fail('Static server did not become ready');
    await new Promise(r=>setTimeout(r,100));
  }
  const runtime=await import(pathToFileURL(runtimePath).href);
  const {chromium}=runtime.default??runtime;
  const browser=await chromium.launch({headless:true,channel:'chrome'});
  t.after(()=>browser.close());
  const routes=[], errors=[], failedAssets=[];
  for(const width of [1280,390]) {
    const context=await browser.newContext({viewport:{width,height:900}});
    // Only the local export is contacted. Market reads, analytics and wallet
    // discovery are not evidence of provider availability in this test.
    await context.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
    const page=await context.newPage();
    page.setDefaultTimeout(10000);
    page.on('pageerror',error=>errors.push(error.message));
    page.on('response',response=>{
      const url=new URL(response.url());
      if(url.origin===origin && response.status()>=400)failedAssets.push(`${response.status()} ${url.pathname}`);
    });
    async function visit(path,heading) {
      const response=await page.goto(origin+path);
      assert.equal(response.status(),200,path);
      await page.getByRole('heading',{name:heading,exact:true,level:1}).waitFor({timeout:20000});
      assert.deepEqual(errors,[],path);
      assert.deepEqual(failedAssets,[],path);
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,path);
      routes.push({width,path});
    }
    await visit('/','Borrow USDG against Stock Tokens.');
    await page.getByRole('region',{name:'Upcoming token markets'}).getByText('CASHCAT and PONS · Coming soon',{exact:true}).waitFor();
    if(width===390)await page.getByRole('button',{name:'Open navigation',exact:true}).click();
    await page.getByRole('navigation',{name:'Primary',exact:true}).getByRole('link',{name:'Earn',exact:true}).click();
    await page.getByRole('heading',{name:'Lend USDG',exact:true,level:1}).waitFor();
    assert.equal(new URL(page.url()).pathname,'/earn');
    if(canary)await page.getByText('Not open yet. You can view the market; new deposits are unavailable.',{exact:true}).waitFor();
    else await page.getByRole('heading',{name:'Stock Token lending is not open yet',exact:true}).waitFor();
    assert.equal(await page.getByRole('region',{name:'Upcoming token markets'}).getByRole('link').count(),0);
    for(const ticker of ['aapl','msft','googl','amzn','meta','nvda','amd','orcl','mu','tsla']) {
      await visit(`/borrow/${ticker}`,canary && ticker === 'aapl' ? 'Borrow USDG · AAPL' : `Borrow USDG with ${ticker.toUpperCase()}.`);
    }
    await visit('/borrow?market=nvda','Borrow USDG with NVDA.');
    for(const path of ['/earn/aapl','/earn/aapl/deposit']) {
      await visit(path,'Lend USDG');
      assert.equal(new URL(page.url()).pathname,'/earn');
    }
    for(const route of ['borrow','earn']) {
      if(canary){
        await visit(`/${route}?engine=${canary}`,`${route==='borrow'?'Borrow':'Lend'} USDG · AAPL`);
        await page.getByRole('heading',{name:'This market is not open yet',exact:true}).waitFor();
        assert.equal(await page.getByRole('button',{name:/^Review /}).isDisabled(),true);
        if(process.env.DOCKYARD_CANARY_SCREENSHOTS)await page.screenshot({path:resolve(process.env.DOCKYARD_CANARY_SCREENSHOTS,`${route}-${width}.png`),fullPage:true});
      }
      await visit(`/${route}?engine=0x1111111111111111111111111111111111111111`,'Isolated market unavailable');
      await visit(`/${route}?engine=0x1111111111111111111111111111111111111111&engine=0x2222222222222222222222222222222222222222`,'Isolated market unavailable');
      assert.equal(await page.locator('form').count(),0);
    }
    await context.close();
  }
  assert.deepEqual(errors,[]);
  assert.deepEqual(failedAssets,[]);
  console.log(JSON.stringify({evidence:'stock-static-release-smoke',routes,productionServer:true,
    nextExport:true,externalRequestsBlocked:true,walletTransactions:0,publicPoolsActivated:false}));
});
