import React from 'react';
import {createRoot} from 'react-dom/client';
import {LoanTerms, ZERO_ADDRESS} from '../../src/screens/P2PLoansScreen/loanPresentation';
import type {Offer} from '../../src/screens/P2PLoansScreen/loanPresentation';
import '../../src/screens/P2PLoansScreen/p2p.css';
const lender='0x8D9c41c35a1Cf9A6958d58880d3DC5dca36f5086';
const offer:Offer={market:{version:3,chainId:4663,chainName:'Robinhood',rpcUrl:'/api/rpc',address:lender,loanToken:lender,collateralToken:lender,loanSymbol:'USDG',collateralSymbol:'MSFT',loanDecimals:6,collateralDecimals:18,runtimeHash:'0x00',startBlock:'1'},loan:{id:1n,lender,borrower:ZERO_ADDRESS,isPublic:true,createdAt:1,principal:50000000n,interest:1000000n,collateral:220000000000000000n,durationDays:30,expiresAt:1789497900,dueAt:0,status:'open',fundingAvailable:50000000n}};
const mobile=new URLSearchParams(location.search).has('mobile');
createRoot(document.getElementById('root')!).render(<div style={{maxWidth:mobile?390:820,margin:'20px auto',padding:mobile?10:24,background:'#fafaf9'}}><p>Local preview · illustrative loan · no wallet actions</p><main className="p2p-page" style={{marginTop:20}}><article className="p2p-workspace"><div className="p2p-offer-heading"><h2>MSFT loan #1</h2><span className="p2p-status">Funded · open</span></div><LoanTerms offer={offer} account={lender} now={1788893000} detailed/></article></main></div>);
