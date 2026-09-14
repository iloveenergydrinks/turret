import { useEffect, useState } from "react";
import type { Address } from "viem";
import { CollateralLogo } from "../screens/P2PLoansScreen/CollateralLogo";
import { loadStandingAccount, loadStandingConfig, standingHref } from "./standing-model";
import type { FactoryConfig } from "./factory.mjs";
import { same } from "./quotes.mjs";
import { failMessage, shortAddress } from "./ui-model";
import "./facilities.css";

export function StandingLoans({ config, account }: { config: FactoryConfig; account: Address }) {
  const [page, setPage] = useState<Awaited<ReturnType<typeof loadStandingAccount>> | null>(null), [error, setError] = useState<string | null>(null);
  const [cursor, setCursor] = useState<Address | undefined>(), [epoch, setEpoch] = useState<number | undefined>(), [attempt, refresh] = useState(0);
  useEffect(() => { let live = true; setPage(null); setError(null);
    void loadStandingAccount(config, account, cursor, epoch).then(value => { if (live) setPage(value); }).catch(error => { if (live) setError(failMessage(error)); });
    return () => { live = false; };
  }, [config, account, cursor, epoch, attempt]);
  const reload = () => { setCursor(undefined); setEpoch(undefined); refresh(n => n + 1); };
  return <section className="standing-account-loans"><div className="facility-heading"><div><h2>Your standing loans</h2><p>Loans from reusable lending offers, including repaid loans with withdrawals still to collect.</p></div><button className="facility-text" onClick={reload}>Refresh loans</button></div>
    {error ? <p className="facility-error" role="alert">{error}</p> : !page ? <p role="status">Finding loans and lending balances for your wallet…</p> : <>
      {!page.complete && <div role="status"><p>Still checking loan history. Results may be incomplete. Checked through block {page.indexedThrough} of {page.blockNumber}.</p><button className="facility-secondary" onClick={() => refresh(n => n + 1)}>Continue checking history</button></div>}
      {page.complete && !page.entries.length && <p>{cursor ? "No more lending balances in this page." : "No standing loans or lending balances found for this wallet."}</p>}
      {page.entries.map(entry => <article className="standing-balance" key={entry.address}><CollateralLogo market={entry} /><div><h3>{same(account, entry.lender) ? "Lending against" : "Borrowed against"} {entry.collateralSymbol}</h3><p>Lender <span title={entry.lender}>{shortAddress(entry.lender)}</span></p></div><a className="facility-secondary" href={standingHref(entry.address, "loans")}>Loans and repayments</a>{same(account, entry.lender) && <a className="facility-text" href={standingHref(entry.address, "lend")}>Manage funding</a>}</article>)}
      <div className="facility-buttons standing-pagination">{cursor && <button className="facility-secondary" onClick={reload}>First page</button>}{page.nextCursor && <button className="facility-secondary" onClick={() => { setCursor(page.nextCursor!); setEpoch(page.historyEpoch); }}>More lending balances</button>}</div>
    </>}
  </section>;
}
export function StandingPortfolio({ account, onAvailability }: { account: Address; onAvailability?: (active: boolean) => void }) {
  const [config, setConfig] = useState<FactoryConfig | null>(null), [error, setError] = useState<string | null>(null), [attempt, retry] = useState(0);
  useEffect(() => { let live = true; setError(null); void loadStandingConfig().then(value => { if (live) { setConfig(value); onAvailability?.(!!value); } }).catch(error => { if (live) setError(failMessage(error)); }); return () => { live = false; }; }, [attempt, onAvailability]);
  if (error) return <section className="facility-workspace" role="alert"><h2>Standing loan history is unavailable</h2><p>{error}</p><button className="facility-secondary" onClick={() => retry(n => n + 1)}>Retry standing loans</button></section>;
  return config ? <div className="facility-workspace"><StandingLoans key={account} config={config} account={account} /></div> : null;
}
