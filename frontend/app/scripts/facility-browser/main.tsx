import { createRoot } from "react-dom/client";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Address, EIP1193Provider } from "viem";
import { P2PAppLayout } from "../../src/p2p/P2PAppLayout";
import { FacilityWorkspace } from "../../src/facilities/FacilityWorkspace";
import { loadFacilityQuotes, makeFacilityClient, validateRegistry, type Directory } from "../../src/facilities/ui-model";
import "../../src/app/brand.css";
import "../../src/app/turret-fonts.css";
import "../../src/screens/P2PLoansScreen/p2p.css";

const fixture = await fetch('/test-fixture').then(response => response.json());
const registry = validateRegistry(fixture.config, location.hostname), market = registry.entries[0]!;
if (market.chainId !== 31337 || location.hostname !== '127.0.0.1') throw new Error('This fixture requires the dedicated local chain.');
type Prompt = { method: string; params: unknown; approve: () => Promise<void>; reject: () => void };
function BrowserTest() {
  const [role, setRole] = useState<'lender' | 'borrower'>('lender'), [prompt, setPrompt] = useState<Prompt | null>(null);
  const account = fixture.accounts[role] as Address, selected = useRef(account); selected.current = account;
  const [directory, setDirectory] = useState<Directory | null>(null), [loading, setLoading] = useState(true), [error, setError] = useState<string | null>(null), [revision, refresh] = useState(0);
  const provider = useMemo(() => ({ request: async ({ method, params }: { method: string; params?: unknown }) => {
    if (method === 'eth_accounts' || method === 'eth_requestAccounts') return [selected.current];
    if (method === 'eth_chainId') return '0x7a69';
    const signing = ['eth_sendTransaction', 'eth_signTypedData_v4'].includes(method);
    const send = async () => {
      const response = await fetch(signing ? '/test-wallet-rpc' : '/api/rpc', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
      const value = await response.json(); if (value.error) throw Object.assign(new Error(value.error.message ?? value.error), { code: value.error.code }); return value.result;
    };
    if (!signing) return send();
    return new Promise((resolve, reject) => setPrompt({ method, params, approve: async () => { setPrompt(null); try { resolve(await send()); } catch (error) { reject(error); } }, reject: () => { setPrompt(null); reject(Object.assign(new Error('User rejected the test wallet request.'), { code: 4001 })); } }));
  } }) as unknown as EIP1193Provider, []);
  const client = useMemo(() => makeFacilityClient(market, registry.baseline!, () => selected.current), []);
  useEffect(() => {
    let live = true, running = false; setDirectory(null);
    const read = async () => { if (running) return; running = true; setLoading(true); try { const value = await loadFacilityQuotes(market, account); if (live) { setDirectory(value); setError(null); } } catch (e) { if (live) setError(String(e)); } finally { running = false; if (live) setLoading(false); } };
    void read(); const interval = setInterval(read, 15000); return () => { live = false; clearInterval(interval); };
  }, [account, revision]);
  return <P2PAppLayout activePage="borrow" network="Local chain 31337" wallet={<label>Test wallet <select aria-label="Test wallet" value={role} disabled={!!prompt} onChange={e => setRole(e.target.value as typeof role)}><option value="lender">Lender</option><option value="borrower">Borrower</option></select></label>}>
    <p className="facility-preview-note">Local chain test · test tokens only · approvals use the test wallet below, not MetaMask.</p>
    <FacilityWorkspace key={account} market={market} client={client} account={account} provider={provider} wrongChain={false} directory={directory} loading={loading} error={error} refresh={() => refresh(n => n + 1)} connect={() => {}} initialTab={role === 'lender' ? 'lend' : 'borrow'} />
    {prompt && <dialog open aria-labelledby="test-wallet-title" style={{ position: 'fixed', inset: '15% 16px auto', margin: 'auto', zIndex: 1000, maxWidth: 560, width: 'calc(100% - 32px)', padding: 24, background: 'white', border: '2px solid #292524', borderRadius: 16 }}>
      <h2 id="test-wallet-title">Local test wallet approval</h2><p>{prompt.method === 'eth_signTypedData_v4' ? 'Sign lending terms' : 'Confirm test transaction'}</p><p>Account: {role} · chain 31337 · no real assets</p>
      <details><summary>Exact test request</summary><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: 200, overflow: 'auto' }}>{JSON.stringify(prompt.params, null, 2)}</pre></details>
      <button className="facility-primary" autoFocus onClick={() => void prompt.approve()}>Approve in test wallet</button> <button className="facility-secondary" onClick={prompt.reject}>Reject in test wallet</button>
    </dialog>}
  </P2PAppLayout>;
}
createRoot(document.getElementById('root')!).render(<BrowserTest />);
