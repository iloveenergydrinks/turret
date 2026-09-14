import { LoanActionDialog } from "./LoanActionDialog";
import {RequestCollateralPicker} from "./RequestCollateralPicker";
import { useEffect, useRef, useState } from "react";
import type { Address, EIP1193Provider } from "viem";
import type { Deployment } from "../../p2p/client";
import { signRequestAction, type RequestTerms } from "../../p2p/requests";
import { RequestTermsForm } from "./BorrowerRequests";
import { sameAddress } from "./loanPresentation";
import "./RequestLoanDialog.css";

export function RequestLoanDialog({ markets, initialMarket, account, provider, disabled, onClose, onConnect, onPublished, onViewRequests }: {
  markets: Deployment[]; initialMarket?: string; account: Address | null; provider: EIP1193Provider | null; disabled: boolean;
  onClose: () => void; onConnect: () => void; onPublished: () => void; onViewRequests: () => void;
}) {
  const [marketAddress, setMarketAddress] = useState(initialMarket ?? "");
  const [working, setWorking] = useState(false);
  const [published, setPublished] = useState(false);
  const [error, setError] = useState("");
  const guard = useRef(false);
  const identity = useRef(account); identity.current = account;
  const eligible = markets.filter(m => !m.legacy && (m.version ?? 1) >= 2);
  const market = eligible.find(m => sameAddress(m.address, marketAddress)) ?? eligible[0];
  useEffect(() => { setPublished(false); setError(""); }, [account]);
  async function publish(terms: RequestTerms) {
    if (!account || !provider || !market || disabled || guard.current || published) return;
    const owner = account; guard.current = true; setWorking(true); setError("");
    try {
      await signRequestAction(provider, owner, market, { action: "publish", terms });
      if (identity.current === owner) { setPublished(true); onPublished(); }
    } catch (cause) {
      if (identity.current === owner) setError(cause instanceof Error ? cause.message : "The request could not be published. Check your requests before retrying.");
    } finally { guard.current = false; setWorking(false); }
  }
  const close = () => { if (!guard.current) onClose(); };
  return <LoanActionDialog title={published ? "Request published" : "Borrow USDG"} closeLabel="Close loan request" busy={working} onClose={close}>
    {!published && <p>You want to borrow USDG. Offer your tokens as collateral and ask a lender for the amount you need. Repay the loan plus interest to get your tokens back.</p>}
    {published ? <><p role="status">Your request is public. Lenders can now propose loan terms. No collateral moved and no loan has started.</p>
      <div className="p2p-request-actions"><button className="p2p-button" onClick={onViewRequests}>View marketplace</button><button className="p2p-button p2p-secondary" onClick={close}>Done</button></div></>
      : !account ? <><p>Connect to post your request. Posting only asks for a loan; it does not move your tokens or give you USDG.</p>
        <button className="p2p-button" onClick={onConnect}>Connect wallet</button></>
      : !market ? <p role="status">No markets are available for new requests. Close this window and refresh the markets.</p>
      : <><p>Posting your request only asks for a loan. Your tokens stay in your wallet until a lender funds an offer and you accept it.</p>
        <RequestCollateralPicker markets={eligible} value={market.address} disabled={disabled || working}
          onChange={address => { setMarketAddress(address); setError(""); }} />
        <RequestTermsForm key={`${market.address}:${account}`} market={market} disabled={disabled || working} label="request" onSubmit={publish} />
      </>}
    {error && <p role="alert" className="p2p-request-message">{error}</p>}
    {working && <p role="status">Confirm the listing signature in your wallet. Waiting for the request to be saved…</p>}
  </LoanActionDialog>;
}
