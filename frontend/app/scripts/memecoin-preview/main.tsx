import React from 'react';
import {createRoot} from 'react-dom/client';
import {MemecoinBorrow,MemecoinBorrowView} from '../../src/borrow/MemecoinBorrow';
import {WalletSessionProvider,useWalletSession} from '../../src/wallet/useWalletSession';
import {P2PAppLayout} from '../../src/p2p/P2PAppLayout';
import type {Deployment,OfferPage} from '../../src/p2p/client';
import registry from '../../public/p2p-markets.json';
import '../../src/app/brand.css';
import '../../src/app/turret-fonts.css';
import '../../src/screens/P2PLoansScreen/p2p.css';

const fixture=new URLSearchParams(location.search).get('fixture');
const market=registry.markets.find(m=>m.collateralSymbol==='CASHCAT'&&m.version===3) as Deployment;
const now=Date.now();
const page:OfferPage={offers:fixture==='empty'?[]:[{id:1n,isPublic:true,status:'open',createdAt:Math.floor(now/1000)-60,
  expiresAt:Math.floor(now/1000)+300,dueAt:0,durationDays:7,principal:100_000000n,interest:5_000000n,
  collateral:1000n*10n**18n,fundingAvailable:100_000000n,lender:'0x1111111111111111111111111111111111111111',borrower:'0x0000000000000000000000000000000000000000'}],
  now:Math.floor(now/1000),blockNumber:100n,paused:fixture==='paused',nextCursor:null,
  health:{status:'ok',reasons:[],checkedAt:now,blockNumber:'100',blockHash:`0x${'a'.repeat(64)}`}};
function Preview(){
  const session=useWalletSession();
  return <P2PAppLayout activePage="borrow" network="Robinhood Chain" wallet={<button className="p2p-button p2p-secondary" onClick={()=>void session.connect()}>{session.account?'Wallet connected':'Connect wallet'}</button>}>
    <p style={{fontSize:13,color:'#57534e'}}>Local preview · {fixture?'illustrative terms; transaction links disabled':'live read-only offer discovery; lending actions open the existing site'}.</p>
    <div onClickCapture={event=>{
      const anchor=(event.target as HTMLElement).closest('a');
      if(anchor?.getAttribute('href')?.startsWith('/')) {
        if(fixture){event.preventDefault();return;}
        anchor.href=new URL(anchor.getAttribute('href')!,'https://turret.capital').href;
      }
    }}>{fixture?<MemecoinBorrowView data={{reads:[{market,page,checkedAt:now,error:fixture==='error'}],loading:false,error:false,now,address:undefined,wrongChain:false,balances:{},retry:()=>location.reload(),loadMore:null}}/>:<MemecoinBorrow/>}</div>
  </P2PAppLayout>;
}
createRoot(document.getElementById('root')!).render(<WalletSessionProvider><Preview/></WalletSessionProvider>);
