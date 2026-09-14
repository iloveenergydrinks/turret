// Runs against a served production export or the live site. Never signs or sends transactions.
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import test from 'node:test';

const origin=process.env.WALLET_TEST_URL;
const runtime=process.env.DOCKYARD_PLAYWRIGHT_MODULE;
assert.ok(origin && runtime, 'Set WALLET_TEST_URL and DOCKYARD_PLAYWRIGHT_MODULE');
const {chromium,devices}=await import(pathToFileURL(runtime).href);

test('MetaMask is available on mobile and connects through its injected provider', {timeout:120000}, async t=>{
  const browser=await chromium.launch({headless:true,channel:'chrome'});
  t.after(()=>browser.close());
  for(const device of ['iPhone 13','Pixel 7','Desktop Chrome']) {
    await t.test(`${device}: visible MetaMask with a working handoff target`,async()=>{
      const context=await browser.newContext(devices[device]);
      try {
        const page=await context.newPage();
        page.setDefaultTimeout(15000);
        const url=new URL('/borrow/aapl?source=wallet-test&amount=1#position',origin).href;
        await page.goto(url,{waitUntil:'domcontentloaded'});
        await page.getByRole('button',{name:'Connect',exact:true}).first().click();
        const link=page.getByRole('link',{name:'MetaMask',exact:true});
        await link.waitFor();
        assert.equal(await link.count(),1);
        const expected=device==='Desktop Chrome' ? 'https://metamask.io/download/'
          : `https://metamask.app.link/dapp/${url.replace(/^https?:\/\//,'')}`;
        assert.equal(await link.getAttribute('href'),expected);
        assert.ok(!expected.includes('/wc?'));
        const handoff=page.waitForRequest(request=>request.url().split('#')[0]===expected.split('#')[0]);
        await page.route('https://metamask.**/**',route=>route.abort());
        await link.click({noWaitAfter:true});
        await handoff;
      } finally {await context.close();}
    });
  }
  for(const announced of [false,true]) {
    await t.test(`MetaMask mobile provider connects without reopening the app (${announced?'EIP-6963':'legacy injection'})`,async()=>{
      const context=await browser.newContext(devices['iPhone 13']);
      try {
        await context.addInitScript(({announced})=>{
          let connected=false;
          window.walletTestRequests=[];
          const provider={
            isMetaMask:true,
            on(){},removeListener(){},
            async request({method}) {
              window.walletTestRequests.push(method);
              if(method==='eth_chainId')return '0x1237';
              if(method==='eth_accounts')return connected?['0x1111111111111111111111111111111111111111']:[];
              if(method==='eth_requestAccounts'){connected=true;return ['0x1111111111111111111111111111111111111111'];}
              if(method==='wallet_requestPermissions')return [{parentCapability:'eth_accounts'}];
              if(method==='wallet_getPermissions')return [];
              throw new Error(`Unexpected wallet request: ${method}`);
            },
          };
          window.ethereum=provider;
          if(announced){
            const announce=()=>window.dispatchEvent(new CustomEvent('eip6963:announceProvider',{detail:{provider,info:{
              uuid:'c6e16cc1-631b-43db-a2b2-00aa890cfc10',name:'MetaMask',rdns:'io.metamask.mobile',
              icon:'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg"/>',
            }}}));
            window.addEventListener('eip6963:requestProvider',announce);announce();
          }
        },{announced});
        const page=await context.newPage();page.setDefaultTimeout(15000);
        await page.goto(origin,{waitUntil:'domcontentloaded'});
        await page.getByRole('button',{name:'Connect',exact:true}).first().click();
        assert.equal(await page.getByRole('link',{name:'MetaMask',exact:true}).count(),0);
        const metamask=page.getByRole('button',{name:'MetaMask',exact:true});
        await metamask.waitFor();assert.equal(await metamask.count(),1);
        await metamask.click();
        await page.getByRole('button',{name:/Open wallet menu for 0x1111/}).waitFor();
        const methods=await page.evaluate(()=>window.walletTestRequests);
        assert.ok(methods.includes('eth_requestAccounts'));
        assert.ok(!methods.some(method=>/sendTransaction|sign/i.test(method)));
      } finally {await context.close();}
    });
  }
});
