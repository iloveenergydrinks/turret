"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useAccount, usePublicClient, useSwitchChain, useWalletClient } from "wagmi";
import { useModal } from "connectkit";
import type { Hash } from "viem";
import { READ_ONLY_DEPLOYMENT } from "@/src/deployment-config";
import { deployment, legacyDeployment, readStaking, readLiveRewards, STAKING_CHAIN_ID, type LiveRewards, type StakingDeployment, type StakingState } from "./client";
import { StakingView, type Review, type StakingViewProps } from "./StakingView";
import { readPendingFees, STAKING_REFRESH_MS, type PendingFees } from "./fees";
import { parsePending, rejected, sendStaking, settleStaking, type StakingAction, type StakingPending, type StakingStage } from "./transactions";

const noop = () => {};
export function StakingPage({ legacy = false }: { legacy?: boolean }) {
  if ((!deployment && !legacy) || READ_ONLY_DEPLOYMENT) return <StakingView deployment={null} connected={false} wrongChain={false} mode="stake" amount="" busy={false} pending={null} recoveryHash="" storageError={false} error="" notice="" onMode={noop} onAmount={noop} onReview={noop} onConfirm={noop} onRefresh={noop} onRecover={noop} onRecoveryHash={noop} onConnect={noop} onSwitchChain={noop} />;
  return <ConnectedStaking key={legacy ? legacyDeployment.address : deployment!.address} deployment={legacy ? legacyDeployment : deployment!} />;
}

export function ConnectedStaking({ deployment: d }: { deployment: StakingDeployment }) {
  const { address, chainId } = useAccount();
  const client = usePublicClient({ chainId: STAKING_CHAIN_ID });
  const { data: wallet, refetch: refreshWallet } = useWalletClient({ chainId: STAKING_CHAIN_ID });
  const { switchChainAsync } = useSwitchChain();
  const { setOpen } = useModal();
  const [state, setState] = useState<StakingState>();
  const [fees, setFees] = useState<PendingFees>();
  const [feesError, setFeesError] = useState(false);
  const [liveRewards, setLiveRewards] = useState<LiveRewards>();
  const [liveError, setLiveError] = useState(false);
  const [mode, setMode] = useState<"stake" | "unstake">(d.legacy ? "unstake" : "stake");
  const [amount, setAmount] = useState("");
  const [review, setReview] = useState<Review>();
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState<StakingAction>();
  const [stage, setStage] = useState<StakingStage>();
  const [pending, setPending] = useState<StakingPending | null>(null);
  const [recoveryHash, setRecoveryHash] = useState("");
  const [storageError, setStorageError] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [receipt, setReceipt] = useState<Hash>();
  const scope = `${d.address}:${address}:${chainId}`;
  const scopeRef = useRef(scope), mounted = useRef(true), readId = useRef(0), lock = useRef(false);
  scopeRef.current = scope;
  const journalKey = `turret:staking:${STAKING_CHAIN_ID}:${d.address.toLowerCase()}:${address?.toLowerCase()}`;
  const connected = !!address && chainId === STAKING_CHAIN_ID;
  const refresh = useCallback(async () => {
    if (!client) return;
    const target = scope, id = ++readId.current;
    try {
      const next = await readStaking(client, d, connected ? address : undefined);
      if (mounted.current && scopeRef.current === target && readId.current === id) {
        setState(next);
        if (!d.rewardModel && !d.legacy) void readPendingFees(client, d, next).then(value => {
          if (mounted.current && scopeRef.current === target && readId.current === id) { setFees(value); setFeesError(false); }
        }).catch(() => {
          if (mounted.current && scopeRef.current === target && readId.current === id) { setFees(undefined); setFeesError(true); }
        });
        return next;
      }
    } catch (e) {
      if (mounted.current && scopeRef.current === target && readId.current === id) {
        setState(undefined); setLiveRewards(undefined); setLiveError(false); setFees(undefined); setFeesError(true); setError(e instanceof Error ? e.message : "Staking balances could not be checked. Refresh to try again.");
      }
    }
  }, [client, d, address, connected, scope]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    setState(undefined); setLiveRewards(undefined); setLiveError(false); setFees(undefined); setFeesError(false); setReview(undefined); setAmount(""); setError(""); setNotice(""); setReceipt(undefined); setPending(null); setRecoveryHash(""); setStorageError(false);
    const recover = () => {
      if (!address) return;
      try { const raw = localStorage.getItem(journalKey); setPending(raw ? parsePending(raw, d, address) : null); setStorageError(false); }
      catch { setStorageError(true); setError("Saved transaction recovery is unavailable or invalid. Check your wallet activity and site storage before sending another transaction."); }
    };
    recover(); void refresh();
    const timer = setInterval(() => void refresh(), STAKING_REFRESH_MS);
    const storage = (e: StorageEvent) => { if (e.key === journalKey) recover(); };
    window.addEventListener("storage", storage); window.addEventListener("focus", recover);
    return () => { clearInterval(timer); window.removeEventListener("storage", storage); window.removeEventListener("focus", recover); };
  }, [address, d, journalKey, refresh]);

  const liveReady = !!state;
  useEffect(() => {
    setLiveRewards(undefined); setLiveError(false);
    if (!client || !liveReady || !connected || !address || !d.rewardModel) return;
    let active = true, reading = false;
    const target = scope;
    const update = async () => {
      if (reading) return;
      reading = true;
      try {
        const next = await readLiveRewards(client, d, address);
        if (active && scopeRef.current === target) { setLiveRewards(next); setLiveError(false); }
      } catch { if (active && scopeRef.current === target) setLiveError(true); }
      finally { reading = false; }
    };
    void update();
    const timer = setInterval(() => void update(), 5_000);
    return () => { active = false; clearInterval(timer); };
  }, [client, d, liveReady, connected, address, scope]);

  const targetScope = scope;
  const validScope = () => mounted.current && scopeRef.current === targetScope;
  const remember = (value: StakingPending | null) => {
    if (value) localStorage.setItem(journalKey, JSON.stringify(value)); else localStorage.removeItem(journalKey);
    if (validScope()) setPending(value);
  };
  const finish = async (action: StakingAction, hash: Hash) => {
    if (!validScope()) return;
    setReceipt(hash); setReview(undefined); setAmount(""); setState(undefined);
    setNotice(action === "approve" ? "TURRET approval confirmed. Your tokens are not staked yet. Review and confirm the stake."
      : action === "stake" ? d.rewardModel ? "Stake confirmed. Your TURRET now earns USDG as the funded reserve releases rewards." : "Stake confirmed. Your TURRET now participates in future fee distributions."
      : action === "unstake" ? "Withdrawal confirmed. TURRET was returned to your wallet; earned USDG remains claimable."
      : "USDG claim confirmed. Your TURRET stake is unchanged.");
    await refresh();
  };
  const confirm = async () => {
    if (lock.current || pending || storageError || !review) return;
    if (!address || !connected) { setError("Reconnect your wallet on Robinhood Chain, then review the withdrawal again."); setOpen(true); return; }
    if (!client) { setError("The network connection is unavailable. Refresh balances and try again."); return; }
    if (d.legacy && review.action === "stake") { setError("The previous staking contract supports withdrawals and claims only."); return; }
    lock.current = true; setBusy(true); setStage("checking"); setError(""); setNotice(""); setReceipt(undefined);
    try {
      // Account discovery can finish before the connector's signer query.
      // Refresh that query on click instead of silently ignoring the action.
      const signingWallet = wallet ?? (await refreshWallet()).data;
      if (!validScope()) return;
      if (!signingWallet) throw Error("Your wallet signing connection is unavailable. Disconnect and reconnect your wallet, then review again.");
      const run = async () => {
        if (localStorage.getItem(journalKey)) throw Error("A staking transaction is unresolved. Check it before continuing.");
        const send = async (action: StakingAction) => {
          if (validScope()) setPhase(action);
          return sendStaking({ client, wallet: signingWallet, deployment: d, account: address, action, amount: review.amount, currentScope: validScope, remember,
            onStage: next => { if (validScope()) setStage(next); } });
        };
        if (review.action === "stake") {
          const fresh = await readStaking(client, d, address);
          if (!validScope()) return;
          if (fresh.allowance < review.amount) {
            await send("approve");
            if (!validScope()) return;
            setNotice("Approval confirmed. Confirm the stake in your wallet next.");
          }
        }
        const result = await send(review.action);
        await finish(review.action, result.transactionHash);
      };
      if (navigator.locks) await navigator.locks.request(journalKey, { ifAvailable: true }, async held => {
        if (!held) throw Error("Another tab is managing this stake. Finish there, then refresh.");
        await run();
      }); else await run();
    } catch (e) {
      if (validScope()) {
        setError(rejected(e) ? "Cancelled in your wallet. Approval alone does not stake tokens. Refresh balances before trying again." : e instanceof Error ? e.message : "The transaction outcome is unknown. Check wallet activity.");
        setReview(undefined); void refresh();
      }
    } finally { lock.current = false; if (mounted.current) { setBusy(false); setPhase(undefined); setStage(undefined); } }
  };
  const recover = async () => {
    if (lock.current || !client || !pending || !connected) return;
    lock.current = true; setBusy(true); setError("");
    try { const result = await settleStaking(client, pending.hash ? pending : { ...pending, hash: recoveryHash as Hash }, remember); await finish(pending.action, result.transactionHash); }
    catch (e) { if (validScope()) setError(e instanceof Error ? e.message : "Confirmation could not be checked. Try again."); }
    finally { lock.current = false; if (mounted.current) setBusy(false); }
  };
  const current = state?.account?.toLowerCase() === (connected ? address?.toLowerCase() : undefined) ? state : undefined;
  const props: StakingViewProps = {
    deployment: d, liveRewards: connected && liveRewards?.account.toLowerCase() === address?.toLowerCase() ? liveRewards : undefined, liveError, connected, wrongChain: !!address && chainId !== STAKING_CHAIN_ID, state: current,
    fees: fees?.snapshot.account?.toLowerCase() === (connected ? address?.toLowerCase() : undefined) ? fees : undefined, feesError,
    mode, amount, review, busy, phase, stage, pending, recoveryHash, storageError, error, notice, receipt,
    onMode: next => { setMode(next); setAmount(""); setReview(undefined); }, onAmount: setAmount,
    onReview: next => { setReview(next); setError(""); setNotice(""); }, onConfirm: () => void confirm(),
    onRefresh: () => { setError(""); void refresh(); }, onRecover: () => void recover(), onRecoveryHash: setRecoveryHash,
    onConnect: () => setOpen(true), onSwitchChain: () => void switchChainAsync({ chainId: STAKING_CHAIN_ID }).catch(() => setError("Network switch was not completed. Select Robinhood Chain in your wallet.")),
  };
  return <StakingView {...props} />;
}
