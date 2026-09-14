// Test-only entrypoint. Actual screen, Wagmi connector and transaction helpers.
import React, {useEffect} from 'react';
import {createRoot} from 'react-dom/client';
import {WagmiProvider,createConfig,http,useConnect} from 'wagmi';
import {injected} from 'wagmi/connectors';
import {defineChain} from 'viem';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import '@fontsource-variable/figtree';
import '../../src/app/brand.css';
import {IsolatedMarketScreen} from '../../src/screens/IsolatedMarketScreen/IsolatedMarketScreen';

const fixture=await (await fetch('/fixture.json')).json();
if(location.hostname!=='127.0.0.1'||new URL(fixture.rpcUrl).hostname!=='127.0.0.1')throw Error('Local fixture only');
const chain=defineChain({id:4663,name:'Local Robinhood fixture',nativeCurrency:{name:'Ether',symbol:'ETH',decimals:18},
  rpcUrls:{default:{http:[fixture.rpcUrl]}}});
const config=createConfig({chains:[chain],connectors:[injected()],transports:{4663:http(fixture.rpcUrl)},pollingInterval:500});
const queries=new QueryClient();
function LocalScreen(){
  const {connect,connectors}=useConnect();
  useEffect(()=>{connect({connector:connectors[0]!});},[]);
  return <><p>Local integration test · disposable wallet · no production funds</p>
    <IsolatedMarketScreen market={fixture.market} mode={location.search.includes('earn')?'earn':'borrow'}/></>;
}
createRoot(document.getElementById('root')!).render(<WagmiProvider config={config}><QueryClientProvider client={queries}><LocalScreen/></QueryClientProvider></WagmiProvider>);
