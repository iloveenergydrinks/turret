// Test harness only. Keys stay in the parent process; the browser gets an
// injected EIP-1193 wallet constrained to this disposable local Anvil chain.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {formatUnits,decodeFunctionData,erc20Abi} from 'viem';
const require=createRequire(new URL('../../package.json',import.meta.url));
const {createServer}=createRequire(require.resolve('vitest/package.json'))('vite');
const react=require('@vitejs/plugin-react').default;
const root=fileURLToPath(new URL('.',import.meta.url));

export async function startStockBrowser({client,deployment,rpcUrl,offset,wallets,playwrightModule}) {
  assert.equal(new URL(rpcUrl).hostname,'127.0.0.1');
  assert.equal(await client.getChainId(),4663);
  assert.match(await client.request({method:'web3_clientVersion'}),/anvil/i);
  const aliases=new Map([
    ['@/src/env','export const CHAIN_BLOCK_EXPLORER=null;'],
    ['@/src/deployment-config','export const READ_ONLY_DEPLOYMENT=false;'],
    ['@/src/isolated-market-config','export const getIsolatedMarket=()=>undefined;'],
    ['@/src/screens/DockyardBorrowScreen/BorrowerAlerts','export const BorrowerAlerts=()=>null;'],
  ]);
  const server=await createServer({configFile:false,root,plugins:[react(),{
    name:'stock-local-fixture',
    resolveId(id){if(aliases.has(id))return '\0'+id;if(id.startsWith('\0')&&aliases.has(id.slice(1)))return id;},
    load(id){if(id.startsWith('\0'))return aliases.get(id.slice(1));},
    configureServer(s){s.middlewares.use('/fixture.json',(_req,res)=>{
      res.setHeader('Content-Type','application/json');res.setHeader('Cache-Control','no-store');
      res.end(JSON.stringify({rpcUrl,market:{...deployment,symbol:'AAPL'}}));
    });},
  }],resolve:{alias:[...Array.from(aliases.keys(),find=>({find,replacement:'\0'+find})),
    {find:'@',replacement:fileURLToPath(new URL('../..',import.meta.url))}]},
    css:{postcss:{plugins:[]}},server:{host:'127.0.0.1',port:0,strictPort:true},logLevel:'error'});
  let browser;
  try {
    await server.listen();
    const runtime=await import(pathToFileURL(playwrightModule).href);
    const {chromium}=runtime.default??runtime;
    browser=await chromium.launch({headless:true,channel:'chrome'});
    const base=`http://127.0.0.1:${server.httpServer.address().port}`;
    const entries=new Map(),errors=[];
    for(const [index,wallet] of wallets.entries()) {
      const context=await browser.newContext({viewport:{width:index===0?1280:390,height:900}});
      await context.route('**/*',route=>new URL(route.request().url()).hostname==='127.0.0.1'?route.continue():route.abort());
      const page=await context.newPage(),sent=[];
      page.on('pageerror',error=>errors.push(error.message));
      await page.exposeFunction('dockyardLocalWallet',async({method,params=[]})=>{
        if(method==='eth_accounts'||method==='eth_requestAccounts')return [wallet.account.address];
        if(method==='eth_chainId')return '0x1237';
        if(method==='wallet_switchEthereumChain'){assert.equal(params[0].chainId,'0x1237');return null;}
        if(method==='eth_sendTransaction') {
          const tx=params[0];assert.equal(tx.from.toLowerCase(),wallet.account.address.toLowerCase());
          assert.ok([deployment.engine,deployment.pool,deployment.collateral,'0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168']
            .some(address=>address.toLowerCase()===tx.to.toLowerCase()));
          assert.equal(BigInt(tx.value??0),0n);assert.ok(BigInt(tx.gas)>0n&&BigInt(tx.gas)<=5000000n);
          if(tx.data.startsWith('0x095ea7b3'))assert.notEqual(decodeFunctionData({abi:erc20Abi,data:tx.data}).args[1],2n**256n-1n);
          const hash=await wallet.sendTransaction({to:tx.to,data:tx.data,value:0n,gas:BigInt(tx.gas),chain:null});
          sent.push({kind:tx.data.startsWith('0x095ea7b3')?'approval':'transaction',hash,to:tx.to,data:tx.data});return hash;
        }
        if(/^eth_(call|estimateGas|gasPrice|feeHistory|get[A-Z].*|blockNumber|maxPriorityFeePerGas)$/.test(method)||method==='net_version')
          return client.request({method,params});
        throw Error('Unsupported local wallet method');
      });
      await page.addInitScript(({offset})=>{
        const realNow=Date.now;Date.now=()=>realNow()+offset;
        const events=new Map();
        window.ethereum={isMetaMask:true,request:args=>window.dockyardLocalWallet(args),
          on:(name,fn)=>{if(!events.has(name))events.set(name,new Set());events.get(name).add(fn);},
          removeListener:(name,fn)=>events.get(name)?.delete(fn)};
      },{offset});
      // Compile and mount before starting the two-minute service recovery. A
      // broken fixture must not consume the full integration wait first.
      await page.goto(`${base}/?mode=${index===0?'borrow':'earn'}`);
      await page.getByRole('heading',{level:1}).waitFor({timeout:20000});
      assert.deepEqual(errors,[]);
      entries.set(wallet.account.address.toLowerCase(),{page,sent});
    }
    return {
      origin:base,
      async action(address,intent) {
        const {page,sent}=entries.get(address.toLowerCase()),before=sent.length;
        const mode=['lend','withdraw','redeem','redeemWorthless'].includes(intent.kind)?'earn':'borrow';
        await page.goto(`${base}/?mode=${mode}`);
        try {
          await page.getByRole('region',{name:'Market and position'}).waitFor({timeout:20000});
          await page.getByLabel('Action',{exact:true}).selectOption(intent.kind);
          if(intent.kind==='depositBorrow')await page.locator('#isolated-collateral').fill(formatUnits(intent.collateralAmount,18));
          const decimals=['addCollateral','removeCollateral'].includes(intent.kind)?18:['redeem','redeemWorthless'].includes(intent.kind)?12:6;
          await page.locator('#isolated-amount').fill(formatUnits(intent.amount,decimals));
          await page.locator('button[type="submit"]').click();
          for(let step=0;step<4;step++) {
            const confirm=page.getByRole('button',{name:'Confirm in wallet',exact:true});
            await confirm.click({timeout:20000});
            await page.waitForFunction(()=>document.body.textContent.includes('Transaction confirmed. Balances refresh automatically.')
              ||[...document.querySelectorAll('button')].some(b=>b.textContent==='Confirm in wallet'&&!b.disabled),{},{timeout:30000});
            if(await page.getByText('Transaction confirmed. Balances refresh automatically.',{exact:true}).count()) {
              assert.deepEqual(errors,[]);
              assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
              return sent.slice(before);
            }
          }
          assert.fail('Browser approval flow did not complete');
        }catch(error){throw new Error(`${intent.kind}: ${error.message}\n${(await page.locator('body').innerText()).slice(-5000)}`);}
      },
      async close(){await browser.close();await server.close();},
    };
  }catch(error){await browser?.close();await server.close();throw error;}
}
