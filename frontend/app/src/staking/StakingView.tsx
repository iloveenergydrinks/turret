"use client";
import { useEffect, useRef } from "react";
import { formatUnits, type Hash } from "viem";
import { positiveAmount } from "@/src/dockyard-amount";
import { TURRET, USDG, TREASURY, type StakingDeployment, type StakingState, type LiveRewards } from "./client";
import type { StakingAction, StakingPending, StakingStage } from "./transactions";
import type { PendingFees } from "./fees";
import { RewardCounter } from "./RewardCounter";
import "./staking.css";

export type Review = { action: "stake" | "unstake" | "claim"; amount: bigint };
export type StakingViewProps = {
  deployment: StakingDeployment | null; connected: boolean; wrongChain: boolean; state?: StakingState;
  fees?: PendingFees; feesError?: boolean; liveRewards?: LiveRewards; liveError?: boolean;
  mode: "stake" | "unstake"; amount: string; review?: Review; busy: boolean; phase?: StakingAction; stage?: StakingStage;
  pending: StakingPending | null; recoveryHash: string; storageError: boolean; error: string; notice: string; receipt?: Hash;
  onMode: (mode: "stake" | "unstake") => void; onAmount: (value: string) => void; onReview: (review?: Review) => void;
  onConfirm: () => void; onRefresh: () => void; onRecover: () => void; onRecoveryHash: (hash: string) => void;
  onConnect: () => void; onSwitchChain: () => void;
};
const amountText = (amount: bigint, decimals: number) => formatUnits(amount, decimals);
const displayAmount = (amount: bigint, decimals: number) => {
  const [whole = "0", fraction] = formatUnits(amount, decimals).split(".");
  return BigInt(whole).toLocaleString("en-US") + (fraction ? `.${fraction}` : "");
};
const explorer = "https://robinhoodchain.blockscout.com";

export function StakingView(p: StakingViewProps) {
  const { deployment: d } = p;
  const streaming = !!d?.rewardModel;
  const legacy = !!d?.legacy;
  const state = p.state && p.liveRewards && p.connected && p.liveRewards.blockNumber >= p.state.blockNumber ? { ...p.state, earned: p.liveRewards.earned, staked: p.liveRewards.staked, totalStaked: p.liveRewards.totalStaked } : p.state;
  const reviewHeading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { if (p.review) reviewHeading.current?.focus(); }, [p.review]);
  const value = positiveAmount(p.amount, 18);
  const withdrawalWaiting = p.mode === "unstake" && !!state && state.staked > 0n && !state.canUnstake;
  const available = p.mode === "stake" ? state?.walletBalance : state?.staked;
  const locked = p.busy || !!p.pending || p.storageError;
  const share = state && state.totalStaked > 0n ? `${Number(state.staked * 1_000_000n / state.totalStaked) / 10_000}%` : "0%";
  return <div className="turret-staking dockyard-isolated dockyard-earn-index">
    <header className="dockyard-earn-index-header">
      <h1>{legacy ? "Move your existing stake" : "Stake TURRET. Earn USDG."}</h1>
      <p>{legacy ? "Withdraw TURRET from the previous staking contract, then stake it in the new reward reserve. Previously earned USDG remains available to claim here." : streaming ? "Stake your TURRET to earn USDG gradually from a funded reward reserve. Claim your accrued rewards and withdraw your tokens after a short delay." : "Share in Turret’s lending fees. Stake your TURRET, claim USDG when fees are distributed, and withdraw your tokens after a short delay."}</p>
    </header>
    {streaming && <p className="turret-staking-note">Already staked in the previous contract? <a href="/stake/legacy">Withdraw your existing stake</a>, then return here to stake in the reserve.</p>}
    {legacy && <p><a href="/stake">Go to the new staking reserve</a></p>}
    {!d ? <section className="turret-staking-unavailable" aria-label="Staking availability">
      <h2>Staking is not active yet</h2>
      <p role="status">The TURRET staking contracts have not been activated in this app. No staking deposits or fee rewards are available here yet.</p>
      <p>The planned split sends 50% of collected protocol fees to stakers and retains 50% in the treasury.</p>
      <a className="dockyard-secondary-action" href="/earn">View lending pools</a>
    </section> : <div className="turret-staking-workspace">
      <section className="turret-staking-position" aria-label="Manage TURRET stake">
        <h2>Your TURRET</h2>
        <dl className="turret-staking-balances">
          <div><dt>In your wallet</dt><dd>{state && p.connected ? displayAmount(state.walletBalance, 18) : "—"}<span> TURRET</span></dd></div>
          <div><dt>Staked</dt><dd>{state && p.connected ? displayAmount(state.staked, 18) : "—"}<span> TURRET</span></dd></div>
        </dl>
        {!p.connected ? <div className="turret-staking-connect"><p>{p.wrongChain ? "Switch to Robinhood Chain to manage your stake." : "Connect your wallet to check your TURRET balance and stake."}</p>
          <button className="dockyard-primary-action" onClick={p.wrongChain ? p.onSwitchChain : p.onConnect}>{p.wrongChain ? "Switch to Robinhood Chain" : "Connect wallet"}</button>
        </div> : !state ? <p role="status">{p.error ? "Balances are unavailable. Refresh before continuing." : "Checking staking contracts and balances…"}</p> : p.review ? <section className="turret-staking-review" aria-label="Review staking transaction">
          <h3 ref={reviewHeading} tabIndex={-1}>{p.review.action === "stake" ? "Review your stake" : p.review.action === "unstake" ? "Review your withdrawal" : "Review your USDG claim"}</h3>
          <p>{p.review.action === "stake" ? `Move ${displayAmount(p.review.amount, 18)} TURRET from your wallet into the staking contract. Your stake participates in future rewards.`
            : p.review.action === "unstake" ? `Return ${displayAmount(p.review.amount, 18)} TURRET to your wallet. These tokens stop participating in future distributions. Earned USDG remains claimable.`
            : `Claim your earned USDG to your connected wallet. Currently claimable: ${displayAmount(state.earned, 6)} USDG. Your TURRET stays staked.`}</p>
          {p.review.action === "stake" && <p>{state.allowance < p.review.amount ? "Two wallet confirmations: approve this exact TURRET amount, then stake. Approval alone does not stake your tokens." : "Your approval already covers this amount. Confirm the stake in your wallet."}</p>}
          <p>Transactions require ETH for network fees.</p>
          <details><summary>Review contracts and network</summary><p>Robinhood Chain · 4663</p><p>Staking contract: <a href={`${explorer}/address/${d.address}`} target="_blank" rel="noreferrer">{d.address}</a></p><p>TURRET token: {TURRET}</p><p>USDG token: {USDG}</p></details>
          <div className="turret-staking-actions"><button className="dockyard-primary-action" disabled={locked} onClick={p.onConfirm}>{p.busy ? p.stage === "wallet" ? "Confirm in your wallet…" : p.stage === "confirming" ? "Waiting for confirmation…" : "Checking wallet and balances…" : "Confirm in wallet"}</button><button className="dockyard-secondary-action" disabled={locked} onClick={() => p.onReview(undefined)}>Cancel</button></div>
          {p.busy && <p role="status">{p.stage === "wallet" ? "Open your connected wallet to approve or reject the request." : p.stage === "confirming" ? "Transaction submitted. Waiting for confirmation on Robinhood Chain." : "Checking your wallet connection, current balance and transaction before requesting a signature."}</p>}
        </section> : <>
          {!legacy && <div className="turret-staking-modes" role="group" aria-label="Choose staking action">
            <button aria-pressed={p.mode === "stake"} disabled={locked} onClick={() => p.onMode("stake")}>Stake</button>
            <button aria-pressed={p.mode === "unstake"} disabled={locked} onClick={() => p.onMode("unstake")}>Unstake</button>
          </div>}
          <form onSubmit={event => { event.preventDefault(); if (!locked && !withdrawalWaiting && value > 0n && available !== undefined && value <= available) p.onReview({ action: p.mode, amount: value }); }}>
            <label htmlFor="turret-stake-amount">TURRET to {p.mode === "stake" ? "stake" : "withdraw"}</label>
            <div className="turret-staking-input"><input id="turret-stake-amount" inputMode="decimal" autoComplete="off" placeholder="0" value={p.amount} disabled={locked} onChange={event => p.onAmount(event.target.value)} aria-describedby="turret-stake-amount-help" /><button type="button" disabled={locked || !available} onClick={() => p.onAmount(amountText(available ?? 0n, 18))}>Max</button></div>
            <p id="turret-stake-amount-help">{withdrawalWaiting ? "The withdrawal delay is still active. Refresh balances shortly." : p.amount && value === 0n ? "Enter a positive amount with up to 18 decimal places." : value > (available ?? 0n) ? "This amount exceeds your available TURRET." : p.mode === "stake" ? streaming ? "A short withdrawal delay applies after each stake. USDG accrues from the funded reserve." : "A short withdrawal delay applies after each stake. USDG rewards depend on distributed fees." : "Your earned USDG stays available to claim after you withdraw."}</p>
            <button className="dockyard-primary-action" disabled={locked || withdrawalWaiting || value === 0n || available === undefined || value > available}>Review {p.mode === "stake" ? "stake" : "withdrawal"}</button>
          </form>
          {p.mode === "stake" && state.walletBalance === 0n && <p>You have no TURRET in this wallet. Staking requires TURRET tokens, not lending pool shares.</p>}
        </>}
      </section>
      <section className="turret-staking-rewards" aria-label="USDG fee rewards">
        <h2>Your USDG rewards</h2>
        <dl><div><dt>Available to claim</dt><dd className="turret-staking-claimable">{state && p.connected ? streaming ? <RewardCounter key={`${d.address}:${state.account}`} value={state.earned} /> : displayAmount(state.earned, 6) : "—"} <span>USDG</span></dd></div><div><dt>Your share of total stake</dt><dd>{state && p.connected ? share : "—"}</dd></div></dl>
        <button className="dockyard-primary-action" disabled={!p.connected || !state || state.earned === 0n || locked || !!p.review} onClick={() => p.onReview({ action: "claim", amount: state?.earned ?? 0n })}>Review USDG claim</button>
        {streaming && <p className="turret-staking-note">{p.liveError ? "Live rewards could not be refreshed. Showing the last verified balances; retrying automatically." : p.connected && state ? "Accrued on-chain · Updates every 5 seconds" : "Connect your wallet to see your accrued USDG."}</p>}
        {state && state.earned === 0n && <p>{streaming ? "No USDG to claim yet. Rewards accrue while you have TURRET staked and the reserve is funded." : legacy ? "No USDG remains to claim in the previous contract." : "No USDG to claim yet. Rewards arrive when collected fees are distributed to the staking contract."}</p>}
        <hr />
        {!streaming && !legacy && <section className="turret-staking-accrued" aria-label="Pending USDG distribution">
          <h3>Awaiting distribution</h3>
          <dl><div><dt>For all TURRET stakers</dt><dd>{p.fees ? displayAmount(p.fees.forStakers, 6) : "—"} <span>USDG</span></dd></div>
            {p.connected && <div><dt>Your estimated share</dt><dd>{p.fees ? displayAmount(p.fees.estimatedShare, 6) : "—"} <span>USDG</span></dd></div>}
          </dl>
          <p className="turret-staking-note">50% of fees from paid interest recorded in the supported pools. Your share is set when distributed; this amount is not yet claimable.</p>
          <p className="turret-staking-note">{p.feesError ? "Pending fees are unavailable. Retrying automatically; you can also refresh balances." : p.fees ? <>Updates every 20 seconds · As of <time dateTime={new Date(Number(p.fees.snapshot.timestamp) * 1000).toISOString()}>{new Date(Number(p.fees.snapshot.timestamp) * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</time></> : "Checking pool fees…"}</p>
          <p className="turret-staking-note">Automatic collection checks run about every 5 minutes, processing one eligible pool per cycle. Timing depends on fees, treasury approval and network availability.</p>
        </section>}
        {!streaming && !legacy && <hr />}
        <dl><div><dt>Total TURRET staked</dt><dd>{state ? displayAmount(state.totalStaked, 18) : "—"}</dd></div>{!streaming && !legacy && <div><dt>USDG distributed to staking</dt><dd>{state ? displayAmount(state.totalFunded, 6) : "—"}</dd></div>}</dl>
        {!legacy && state?.treasuryAllowance === 0n && <p className="turret-staking-note">New fee funding needs treasury approval. {streaming ? "Accrual from the funded reserve, claims and withdrawals remain available." : "Existing USDG claims and TURRET withdrawals remain available."}</p>}
      </section>
    </div>}
    {d && <div className="turret-staking-feedback" aria-live="polite">
      {p.notice && <p role="status">{p.notice}</p>}{p.error && <p role="alert">{p.error}</p>}
      {p.pending && <section aria-label="Recover pending staking transaction"><h2>Check your pending transaction</h2><p>A wallet request is unresolved. Check its result before submitting another staking action.</p>
        {!p.pending.hash && <label htmlFor="staking-recovery-hash">Transaction hash from your wallet<input id="staking-recovery-hash" value={p.recoveryHash} onChange={event => p.onRecoveryHash(event.target.value)} autoComplete="off" /></label>}
        <button className="dockyard-secondary-action" disabled={p.busy || !p.connected || (!p.pending.hash && !/^0x[\da-f]{64}$/i.test(p.recoveryHash))} onClick={p.onRecover}>Check transaction</button>
        {p.pending.hash && <a href={`${explorer}/tx/${p.pending.hash}`} target="_blank" rel="noreferrer">View pending transaction</a>}
      </section>}
      {p.receipt && <a href={`${explorer}/tx/${p.receipt}`} target="_blank" rel="noreferrer">View confirmed transaction</a>}
      <button className="dockyard-secondary-action" disabled={p.busy} onClick={p.onRefresh}>Refresh balances</button>
    </div>}
    <section className="turret-staking-explainer" aria-labelledby="staking-fees-heading">
      <h2 id="staking-fees-heading">Where the USDG comes from</h2>
      <p>Borrowers pay interest in USDG. The pools keep 90% for lenders and collect 10% as Turret’s protocol fee. {d ? "Half of that fee is allocated to TURRET stakers." : "The staking design allocates half of that fee to TURRET stakers once activated."}</p>
      <dl className="turret-staking-split" aria-label="Example allocation of 100 USDG paid interest"><div><dt>Lending pools</dt><dd>90 USDG</dd></div><div><dt>TURRET stakers</dt><dd>5 USDG</dd></div><div><dt>Treasury</dt><dd>5 USDG</dd></div></dl>
      <p className="turret-staking-note">Example: 100 USDG of paid interest at the current pool fee. This is an allocation example, not a return estimate.</p>
      {streaming ? <details open><summary>How your USDG accrues</summary>
        <p>The funded reserve releases approximately 1% of its remaining USDG per day, continuously while TURRET is staked. Your share depends on how much TURRET you have staked during each interval. This is the reserve’s release rate, not a 1% daily return on your tokens.</p>
        <p>New funding increases the reward rate; a shrinking reserve lowers it. Funding does not become claimable immediately. When nobody is staking, accrual pauses and the reserve is preserved. New stakes cannot claim rewards from earlier intervals.</p>
        <p>Claim whenever you want. Withdrawing stops future accrual on the withdrawn tokens and preserves USDG already earned. Each new or additional TURRET stake delays withdrawal until the chain observes the next Ethereum parent block. There is no ongoing lockup or fixed APR.</p>
        <p>The reserve receives the staking half of protocol fees and may receive separately recorded treasury subsidies. Fee collection checks run about every 5 minutes. Accrual between collections needs no keeper transaction. Treasury approval is required for new fee funding; direct pool receipts still need separate forwarding.</p>
        {d.rewardModel === "reserve-decay-v2" && <p>Treasury can recover unused subsidy, which reduces future rewards. USDG already earned by stakers and the reserve funded by protocol fees cannot be recovered.</p>}
        <p>Fee router: <a href={`${explorer}/address/${d.router}`} target="_blank" rel="noreferrer">{d.router}</a></p>
      </details> : legacy ? <p>These controls only withdraw your existing TURRET or claim USDG already earned under the previous contract. Moving into the reserve requires a separate approval and stake transaction on the new staking page.</p> : <>
      <details><summary>How distributions and withdrawals work</summary><p>Your reward depends on your share of all TURRET staked when each distribution occurs. There is no fixed APR, token emission or slashing. Each new or additional TURRET stake delays withdrawal until the chain observes the next Ethereum parent block. This can span several Robinhood blocks; it is not a fixed countdown. There is no ongoing lockup. Rewards do not accrue just because time passes.</p><p>Existing pools pay the treasury first. Forwarding requires its USDG approval and a collection transaction. The collector checks about every 5 minutes and processes one eligible pool per cycle, once that pool has at least 0.01 USDG in protocol fees. Pending transactions are checked every 15 seconds; collection can pause if approval or gas is insufficient. The treasury can revoke approval or receive fees directly, so forwarding from these pools is not enforced automatically. With no TURRET staked, the router leaves fees unclaimed in the pools.</p><p>New stakes cannot claim rewards already allocated. They can participate in later distributions of previously collected borrower interest. Withdrawing TURRET does not automatically claim USDG. Token and contract risks still apply; TURRET’s market value can fall.</p>
        {d && <p>Fee router: <a href={`${explorer}/address/${d.router}`} target="_blank" rel="noreferrer">{d.router}</a><br />Treasury: <a href={`${explorer}/address/${TREASURY}`} target="_blank" rel="noreferrer">{TREASURY}</a></p>}
      </details>
      </>}
      <p>Looking for rewards on USDG you lend? <a href="/earn">TURRET lender rewards are a separate program.</a></p>
    </section>
  </div>;
}
