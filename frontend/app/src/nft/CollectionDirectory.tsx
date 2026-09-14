import { useEffect, useState } from 'react';
import type { Address } from 'viem';
import type { NFTConfig } from './client';
import { createNFTCollectionData } from './collection-data.mjs';
type MarketData = { address: string; volume24hUSD: number | null; floorETH: number | null; owners: number | null; fetchedAt: string | null; status: 'current' | 'delayed' | 'unavailable'; sourceURL: string | null };
const logos: Record<string, string> = { '0xe3b34c4bb0f12c82143745eee6a6cf4e3154b1fa': '/brand/nft-collections/cash-cats.png', '0xf08c65564eb07d880021105489552080b08e4319': '/brand/nft-collections/robinhood-punks.png' };
const sources: Record<string, string> = { '0xe3b34c4bb0f12c82143745eee6a6cf4e3154b1fa': 'https://www.coingecko.com/en/nft/cashcatss', '0xf08c65564eb07d880021105489552080b08e4319': 'https://www.coingecko.com/en/nft/robinhood-punks' };
const numeric = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const usd = (v: unknown) => numeric(v) ? new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(v) : '—';
export function CollectionDirectory({ collections, onRequests }: { collections: NFTConfig['collections']; onRequests: (address: Address) => void }) {
  const [rows, setRows] = useState<MarketData[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true;
    const get = createNFTCollectionData({ collections });
    async function update() {
      try {
        const data = await get();
        if (active) { setRows(data.collections); setFailed(false); }
      } catch { if (active) { setRows([]); setFailed(true); } }
      finally { if (active) setLoading(false); }
    }
    void update(); const timer = setInterval(() => void update(), 300_000);
    return () => { active = false; clearInterval(timer); };
  }, [collections.map(c => `${c.address}:${c.enabled}`).join(',')]);
  return <section className="nft-collections" aria-label="Supported collections">
    <p className="nft-tab-help">Collections you can use to borrow USDG. List an NFT you own, or browse owners’ loan requests.</p>
    {collections.filter(c => c.enabled).map(c => {
      const data = rows.find(r => typeof r.address === 'string' && r.address.toLowerCase() === c.address.toLowerCase());
      const logo = logos[c.address.toLowerCase()];
      const checked = data?.fetchedAt ? new Date(data.fetchedAt) : null;
      const source = data?.sourceURL && data.sourceURL === sources[c.address.toLowerCase()] ? data.sourceURL : null;
      return <article className="nft-collection" key={c.address}>
        <div className="nft-collection-identity"><span className="nft-collection-logo">{logo ? <img src={logo} alt="" width="48" height="48" /> : c.name.slice(0, 1)}</span><div><h2>{c.name}</h2><a href={`https://robinhoodchain.blockscout.com/token/${c.address}`} target="_blank" rel="noreferrer">View collection ↗</a></div></div>
        <dl className="nft-collection-stats" aria-label={`${c.name} market activity`}>
          <div><dt>24h trading volume</dt><dd>{usd(data?.volume24hUSD)}</dd></div>
          <div><dt>Floor price</dt><dd>{numeric(data?.floorETH) ? `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 5 }).format(data.floorETH)} ETH` : '—'}</dd></div>
          <div><dt>Owners</dt><dd>{numeric(data?.owners) ? new Intl.NumberFormat().format(data.owners) : '—'}</dd></div>
        </dl>
        <button className="p2p-button p2p-secondary" onClick={() => onRequests(c.address)}>View loan requests</button>
        <p className="nft-collection-source">{loading ? 'Loading market data…' : failed || !data || data.status === 'unavailable' ? 'Market data unavailable' : <>{source && <a href={source} target="_blank" rel="noreferrer">CoinGecko</a>}{checked && Number.isFinite(checked.getTime()) && <> · Fetched <time dateTime={checked.toISOString()}>{checked.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}</time></>}{data.status === 'delayed' ? ' · Update delayed' : ' · Refreshes every 5 minutes'}</>}</p>
      </article>;
    })}
    {!collections.some(c => c.enabled) && <p>No collections are currently available for new loans.</p>}
  </section>;
}
