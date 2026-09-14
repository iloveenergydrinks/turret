"use client";
import { useState } from "react";
import { BorrowNavigation } from "./BorrowNavigation";
import { useMemecoinOffers } from "./useMemecoinOffers";
import { exactOffers, offerAvailability, offerHref } from "./memecoin-offers";
import { CollateralLogo } from "../screens/P2PLoansScreen/CollateralLogo";
import { formatAmount } from "../screens/P2PLoansScreen/loanPresentation";
import "./memecoin-borrow.css";

export function MemecoinBorrow() { return <MemecoinBorrowView data={useMemecoinOffers()} />; }

export function MemecoinBorrowView({data}:{data:ReturnType<typeof useMemecoinOffers>}) {
  const [asset,setAsset]=useState("");
  const [amount,setAmount]=useState("");
  const [days,setDays]=useState("");
  const reads=[...data.reads].sort((a,b)=>{
    const ownedA=(data.balances[a.market.address]??0n)>0n,ownedB=(data.balances[b.market.address]??0n)>0n;
    return Number(ownedB)-Number(ownedA);
  });
  const selected=reads.find(read=>read.market.address===asset)??reads[0];
  const market=selected?.market;
  const availability=selected?offerAvailability(selected,data.now,data.address):null;
  const offers=availability?.offers??[];
  const matching=exactOffers(offers,amount?BigInt(amount):null,days?Number(days):null);
  const amounts=[...new Set(offers.map(loan=>loan.principal.toString()))];
  const durations=[...new Set(offers.map(loan=>loan.durationDays))].sort((a,b)=>a-b);
  const marketUrl=market?`/borrow/p2p?market=${market.address}`:"/borrow/p2p";
  const requestUrl=`${marketUrl}${market?'&':'?'}intent=request`;
  const lendUrl=`${marketUrl}${market?'&':'?'}intent=lend`;
  const unavailable=availability?.state==="unavailable";
  return <section className="borrow-hub meme-borrow">
    <header className="meme-intro">
      <div><h1>Borrow against memecoins, stocks and NFTs</h1>
        <p>Borrow USDG against supported assets without selling them. Choose a pool loan or agree terms directly with a lender on Robinhood Chain.</p>
      </div>
      <img src="/illustrations/turret-collateral-bridge-v1.webp" alt="" width={1536} height={1024} />
    </header>
    <BorrowNavigation active="p2p" />
    <section className="meme-market" aria-labelledby="meme-offers-title">
      <div className="meme-section-heading"><div><h2 id="meme-offers-title">Choose your loan</h2>
        <p>{data.wrongChain?"Switch to Robinhood Chain to see your wallet balances.":data.address?"Your holdings appear first. Choose from exact, lender-funded terms.":"Browse funded terms. Connect your wallet in the header to see your holdings."}</p></div>
        <button className="meme-text-button" onClick={data.retry} disabled={data.loading}>Refresh offers</button>
      </div>
      {data.loading?<p role="status" className="meme-message">Checking funded offers…</p>:data.error?<div role="alert" className="meme-message"><h3>Unable to load markets</h3><p>Refresh offers to check availability. Your existing loans remain in Portfolio.</p></div>:!market?<div className="meme-message"><h3>No supported memecoin markets are available</h3><p><a href="/borrow/p2p">Explore other token loans</a> or <a href="/portfolio">manage existing loans</a>.</p></div>:<>
        <div className="meme-filters">
          <label>Collateral<select value={market.address} onChange={event=>{setAsset(event.target.value);setAmount("");setDays("");}}>
            {reads.map(read=><option key={read.market.address} value={read.market.address}>{read.market.collateralSymbol}</option>)}
          </select></label>
          <label>You receive · USDG<select value={amount} onChange={event=>setAmount(event.target.value)} disabled={!offers.length}>
            <option value="">All funded amounts</option>
            {amount&&!amounts.includes(amount)&&<option value={amount}>{formatAmount(BigInt(amount),6)} · no longer available</option>}
            {amounts.map(value=><option key={value} value={value}>{formatAmount(BigInt(value),6)}</option>)}
          </select></label>
          <label>Loan duration<select value={days} onChange={event=>setDays(event.target.value)} disabled={!offers.length}>
            <option value="">All durations</option>
            {days&&!durations.includes(Number(days))&&<option value={days}>{days} days · no longer available</option>}
            {durations.map(value=><option key={value} value={value}>{value} {value===1?'day':'days'}</option>)}
          </select></label>
        </div>
        <div className="meme-market-identity"><CollateralLogo market={market} /><strong>{market.collateralSymbol}</strong>
          {data.address&&!data.wrongChain&&<span>In your wallet: {data.balances[market.address]===undefined||data.balances[market.address]===null?"unavailable":`${formatAmount(data.balances[market.address]!,market.collateralDecimals)} ${market.collateralSymbol}`}</span>}
        </div>
        {availability?.state==="paused"?<div className="meme-message" role="status"><h3>New loans are paused</h3><p><a href="/portfolio">Manage your existing loans</a>. Their repayment deadlines still apply.</p></div>
          :unavailable&&!offers.length?<div className="meme-message" role="status"><h3>Unable to confirm funded availability</h3><p>Refresh to check current offers. Unverified funding is not shown as available to borrow.</p></div>
          :availability?.state==="empty"?<div className="meme-message"><h3>No funded offers available</h3><p>Request the amount and terms you need. A lender must fund an offer before you can borrow.</p><a className="meme-primary" href={requestUrl}>Request a loan</a></div>
          :matching.length?<>
            <p className="meme-availability" role="status">{matching.length} funded {matching.length===1?'offer':'offers'}{availability?.incomplete?" in loaded results":""}. Each offer is accepted in full; availability is checked again before signing.</p>
            <div className="meme-offers">{matching.map(loan=><article key={loan.id.toString()} aria-label={`${market.collateralSymbol} offer ${loan.id}`} className="meme-offer">
              <dl><div><dt>You receive</dt><dd>{formatAmount(loan.principal,6)} <span>USDG</span></dd></div>
                <div><dt>You lock</dt><dd>{formatAmount(loan.collateral,market.collateralDecimals)} <span>{market.collateralSymbol}</span></dd></div>
                <div><dt>Total repayment</dt><dd>{formatAmount(loan.principal+loan.interest,6)} <span>USDG</span></dd></div>
                <div><dt>Duration</dt><dd>{loan.durationDays} <span>{loan.durationDays===1?'day':'days'}</span></dd></div></dl>
              <div className="meme-offer-action"><p>Includes {formatAmount(loan.interest,6)} USDG fixed interest. Early repayment owes the same total.</p>
                <a className="meme-primary" href={offerHref(market,loan)}>Review loan</a></div>
            </article>)}</div>
          </>:<div className="meme-message"><h3>No offers match these terms</h3><p>Choose another funded amount or duration, or request your own terms.</p><button className="meme-text-button" onClick={()=>{setAmount("");setDays("");}}>Show all funded terms</button><a className="meme-secondary" href={requestUrl}>Request a loan</a></div>}
        {availability?.incomplete&&selected?.page?.nextCursor!=null&&data.loadMore&&<button className="meme-text-button" onClick={data.loadMore}>Check older offers</button>}
        <p className="meme-risk">Repay by the final deadline, including the 24-hour grace period, or the lender can claim all your pledged coins. After repayment, withdraw your collateral to return it to your wallet.</p>
        <details className="meme-details"><summary>Collateral and contract details</summary><p>Robinhood Chain · {market.collateralSymbol}: <span>{market.collateralToken}</span></p><p>Lending contract: <span>{market.address}</span></p><p>Each loan has its own vault. Token restrictions or losses can affect recovery. These contracts have not received an independent external audit.</p></details>
      </>}
    </section>
    <section className="meme-lender"><div><h2>Put your USDG to work</h2><p>Choose the coins you’re willing to lend against and set your terms. Earn fixed interest when borrowers repay; receive their collateral if they default. Its value may fall below what you lent.</p></div><a className="meme-secondary" href={lendUrl}>Create a lending offer</a></section>
    <p className="meme-footer"><a href="/portfolio">Manage existing loans</a><a href="/borrow/pools">Explore pool loans with price-based liquidation</a></p>
  </section>;
}
