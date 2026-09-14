"use client";
import { useEffect, useRef, useState } from 'react';
import { formatUnits, type Address, type Hash, type PublicClient, type WalletClient } from 'viem';
import { useAccount, usePublicClient, useWalletClient } from 'wagmi';
import manifest from './deployment.json';
import type { CashbackClaim, CashbackConfig } from './client';
import { useBorrowerCashback } from './useBorrowerCashback';
import { decodeRecovery, encodeRecovery, recoveryKey, type Recovery } from './recovery';
import { CashbackAlreadyClaimed, CashbackClaimReverted, previewCashbackClaim, submitCashbackClaim, verifyCashbackClaim } from './transactions';
import './cashback.css';
import {recoverWalletClient,type RefreshWalletClient} from '../wallet/recoverWalletClient';

type Props = { account: Address; chainId: number; config: CashbackConfig; client?: PublicClient; wallet?: WalletClient; refreshWallet?: RefreshWalletClient };
const show = (value: bigint | null) => value === null ? 'Unavailable' : `${formatUnits(value, 6)} USDG`;
const short = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;

export function BorrowerCashbackPanel() {
  const { address, chainId } = useAccount();
  const client = usePublicClient({ chainId: manifest.chainId });
  const { data: wallet, refetch: refreshWallet } = useWalletClient();
  if (!manifest.deployment || !address || !chainId) return null;
  return <CashbackPortfolio account={address} chainId={chainId} config={manifest} client={client} wallet={wallet} refreshWallet={refreshWallet} />;
}

export function CashbackPortfolio(props: Props) {
  return <AccountCashback key={recoveryKey(props.config, props.account) + props.chainId} {...props} />;
}

function AccountCashback({ account, chainId, config, client, wallet, refreshWallet }: Props) {
  const rewards = useBorrowerCashback(account, chainId, config);
  const [recovery, setRecovery] = useState<Recovery>({ claims: [], pending: null });
  const current = useRef(recovery), mounted = useRef(true), locked = useRef(false);
  const [ready, setReady] = useState(false), [busy, setBusy] = useState(false), [notice, setNotice] = useState('');
  const [review, setReview] = useState<{ claim: CashbackClaim; amount: bigint } | null>(null);
  const [recoveryHash, setRecoveryHash] = useState('');
  const key = recoveryKey(config, account);
  const connected = chainId === config.chainId;
  function save(value: Recovery) {
    window.localStorage.setItem(key, encodeRecovery(config, account, value));
    current.current = value;
    if (mounted.current) setRecovery(value);
  }
  useEffect(() => {
    mounted.current = true;
    const restore = () => {
      try {
        const raw = window.localStorage.getItem(key);
        const value = raw ? decodeRecovery(config, account, raw) : { claims: [], pending: null };
        current.current = value; setRecovery(value); setReady(true);
      } catch { setReady(false); setNotice('Saved claims could not be read. Enable site storage or restore your saved claim data before submitting.'); }
    };
    restore();
    const changed = (event: StorageEvent) => { if (event.key === key) restore(); };
    window.addEventListener('storage', changed);
    return () => { mounted.current = false; window.removeEventListener('storage', changed); };
  }, [key, account, config]);
  useEffect(() => {
    if (!ready || !rewards.data) return;
    const next = [...current.current.claims];
    let changed = false;
    for (const row of rewards.data.accounts) {
      if (!row.claim) continue;
      const i = next.findIndex(claim => claim.engine.toLowerCase() === row.engine.toLowerCase());
      if (i < 0) { next.push(row.claim); changed = true; }
      else if (row.claim.cumulative > next[i]!.cumulative) { next[i] = row.claim; changed = true; }
    }
    if (changed) try { save({ ...current.current, claims: next }); }
    catch { setReady(false); setNotice('Claims could not be saved. Enable site storage before claiming.'); }
  }, [ready, rewards.data]);

  async function task(action: () => Promise<void>) {
    if (locked.current) return;
    locked.current = true; setBusy(true); setNotice('');
    try { await action(); }
    catch (error) { if (mounted.current) setNotice(error instanceof Error ? error.message : 'Claim could not be checked. Retry after checking your wallet.'); }
    finally { locked.current = false; if (mounted.current) setBusy(false); }
  }
  async function openReview(claim: CashbackClaim) {
    if (!client || !connected) return;
    try {
      const amount = await previewCashbackClaim({ client, config, claim, account });
      if (mounted.current) setReview({ claim, amount });
    } catch (error) {
      if (error instanceof CashbackAlreadyClaimed) {
        save({ ...current.current, claims: current.current.claims.filter(saved =>
          saved.engine.toLowerCase() !== claim.engine.toLowerCase() || saved.cumulative > claim.cumulative) });
        if (mounted.current) await rewards.refresh();
      }
      throw error;
    }
  }
  async function finish(claim: CashbackClaim, hash: Hash) {
    if (!client) return;
    let result;
    try { result = await verifyCashbackClaim({ client, config, claim, account, hash }); }
    catch (error) {
      if (error instanceof CashbackClaimReverted) save({ ...current.current, pending: null });
      throw error;
    }
    save({ ...current.current, pending: null,
      claims: current.current.claims.filter(saved => saved.engine !== claim.engine || saved.cumulative > claim.cumulative) });
    if (mounted.current) {
      setReview(null); setNotice(`Received ${show(result.received)}. Your cashback claim is confirmed.`);
      await rewards.refresh();
    }
  }
  async function confirm() {
    if (!client || !review || !connected || !ready) return;
    const signingWallet = await recoverWalletClient(wallet, refreshWallet);
    if (!mounted.current) return;
    const stored = window.localStorage.getItem(key);
    if (stored && decodeRecovery(config, account, stored).pending) throw new Error('Resolve the pending claim first.');
    await previewCashbackClaim({ client, config, claim: review.claim, account });
    if (!mounted.current) return;
    save({ ...current.current, pending: { claim: review.claim } });
    let hash: Hash;
    try { hash = await submitCashbackClaim({ client, wallet: signingWallet, config, claim: review.claim, account }); }
    catch (error) {
      let cause: unknown = error;
      for (let i = 0; cause && typeof cause === 'object' && i < 10; i++) {
        if ('code' in cause && cause.code === 4001) { save({ ...current.current, pending: null }); break; }
        cause = 'cause' in cause ? cause.cause : null;
      }
      throw error;
    }
    save({ ...current.current, pending: { claim: review.claim, hash } });
    await client.waitForTransactionReceipt({ hash, timeout: 90000 });
    await finish(review.claim, hash);
  }
  async function retryCancelledRequest() {
    if (!client || !connected || !ready || !current.current.pending || current.current.pending.hash) return;
    const claim = current.current.pending.claim;
    // A wallet can close before returning either a hash or a rejection. Only the user
    // can confirm that its outstanding request was cancelled. Recheck payment first.
    try {
      const amount = await previewCashbackClaim({ client, config, claim, account });
      save({ ...current.current, pending: null });
      if (mounted.current) setReview({ claim, amount });
    } catch (error) {
      if (error instanceof CashbackAlreadyClaimed) {
        save({ ...current.current, pending: null, claims: current.current.claims.filter(saved =>
          saved.engine.toLowerCase() !== claim.engine.toLowerCase() || saved.cumulative > claim.cumulative) });
        if (mounted.current) await rewards.refresh();
      }
      throw error;
    }
  }
  const blocked = busy || !connected || !ready || !client || !!recovery.pending;
  const rows = rewards.data?.accounts ?? [];
  return <section className="turret-borrower-cashback" aria-label="Borrower cashback">
    <h2>Borrower cashback</h2>
    <p>Earned from eligible interest you pay. These rewards are separate from TURRET staking and lender incentives.</p>
    {!connected && <p role="status">Switch to the campaign network to check and claim rewards.</p>}
    {rewards.error && <p role="status">Reward updates are unavailable. Saved claims can still be checked directly on chain.</p>}
    {!rewards.data && !rewards.error && connected && <p role="status">Checking your cashback…</p>}
    {rewards.data && !rewards.fresh && <p>These figures are from the last available update. Claims are checked on chain before signing.</p>}
    {rewards.data && rows.length === 0 && <p>This wallet has no funded borrower enrollment.</p>}
    {rows.map(row => <article key={row.engine}>
      <h3>Pool loan <span>{short(row.engine)}</span></h3>
      <dl>
        <div><dt>Estimated on unpaid interest</dt><dd>{show(rewards.fresh ? row.estimatedRebate : null)}</dd></div>
        <div><dt>Confirmed after repayment</dt><dd>{show(row.confirmedRebate)}</dd></div>
        <div><dt>Available to claim</dt><dd>{rewards.fresh ? show(row.claimable) : 'Check on chain'}</dd></div>
        <div><dt>Already claimed</dt><dd>{show(row.claimed)}</dd></div>
      </dl>
      <a href={`/borrow?engine=${row.engine}`}>Manage this loan</a>
    </article>)}
    {recovery.claims.map(claim => <div className="cashback-saved-claim" key={claim.engine}>
      <span>Saved claim · {short(claim.engine)}</span>
      <button type="button" disabled={blocked} onClick={() => void task(() => openReview(claim))}>Review claim</button>
    </div>)}
    {review && !recovery.pending && <section className="cashback-review" aria-label="Review cashback claim">
      <h3>Claim {show(review.amount)}</h3>
      <p>USDG goes to {short(account)}. Your wallet shows the network fee. The amount is checked again before signing.</p>
      <button type="button" disabled={blocked} onClick={() => void task(confirm)}>{busy ? 'Checking claim…' : 'Confirm claim in wallet'}</button>
      <button type="button" disabled={busy} onClick={() => setReview(null)}>Back</button>
    </section>}
    {recovery.pending && <section className="cashback-review" aria-label="Recover cashback claim">
      <h3>Claim awaiting confirmation</h3>
      <p>Check the existing request in your wallet before submitting another claim.</p>
      {!recovery.pending.hash && <label>Transaction hash from your wallet<input value={recoveryHash} onChange={e => setRecoveryHash(e.target.value)} autoComplete="off" /></label>}
      <button type="button" disabled={busy || !client || !connected || (!recovery.pending.hash && !/^0x[0-9a-fA-F]{64}$/.test(recoveryHash))}
        onClick={() => void task(() => finish(recovery.pending!.claim, recovery.pending!.hash ?? recoveryHash as Hash))}>Check claim confirmation</button>
      {!recovery.pending.hash && <>
        <p>If your wallet never sent a transaction, cancel its outstanding request before reviewing again. A transaction sent without a returned hash can still be pending; check your wallet activity first.</p>
        <button type="button" disabled={busy || !client || !connected || !ready}
          onClick={() => void task(retryCancelledRequest)}>I cancelled the unsent request in my wallet</button>
      </>}
    </section>}
    {notice && <p role="status">{notice}</p>}
    <p>Unpaid estimates are not claimable. Confirmed rewards become claimable after their allocation is published.</p>
    <a href="/borrow/cashback-terms">Campaign rules and deadlines</a>
  </section>;
}
