import { useEffect, useState } from "react";
import { erc20Abi, type Address } from "viem";
import { useAccount } from "wagmi";
import { loadP2PRegistry, P2PClient } from "../p2p/client";
import { memecoinMarkets, readOfferPages, type MemecoinMarketRead } from "./memecoin-offers";

export function useMemecoinOffers() {
  const wallet = useAccount();
  const [reads,setReads] = useState<MemecoinMarketRead[]>([]);
  const [loading,setLoading] = useState(true), [error,setError] = useState(false);
  const [revision,setRevision] = useState(0), [pages,setPages] = useState(3);
  const [now,setNow] = useState(Date.now);
  const [balances,setBalances] = useState<{account:Address; at:Record<string,number>; values:Record<string,bigint|null>} | null>(null);
  useEffect(() => {
    let alive = true, busy = false;
    setReads([]); setBalances(null); setLoading(true);
    const refresh = async () => {
      if (!alive || busy || document.visibilityState === "hidden") return;
      busy = true;
      try {
        const registry = await loadP2PRegistry();
        const markets = memecoinMarkets(registry.markets);
        const values: Record<string,bigint|null> = {};
        const balanceTimes: Record<string,number> = {};
        const result = await Promise.all(markets.map(async market => {
          const client = new P2PClient(market);
          try {
            const page = await readOfferPages(client,pages);
            if (wallet.address && wallet.chainId === market.chainId) {
              const address = wallet.address;
              values[market.address] = await client.publicClient.readContract({address:market.collateralToken,
                abi:erc20Abi,functionName:"balanceOf",args:[address],blockNumber:page.blockNumber}).catch(() => null);
              balanceTimes[market.address] = Math.min(Date.now(),page.now*1000);
            }
            return {market,page,checkedAt:Date.now(),error:false};
          } catch { return {market,page:null,checkedAt:Date.now(),error:true}; }
        }));
        if (alive) {
          setReads(result); setError(false);
          setBalances(wallet.address ? {account:wallet.address,at:balanceTimes,values} : null);
        }
      } catch { if (alive) {setError(true);setReads([]);setBalances(null);} }
      finally { busy=false; if(alive)setLoading(false); }
    };
    void refresh();
    const timer=setInterval(refresh,15_000), clock=setInterval(()=>setNow(Date.now()),1000);
    window.addEventListener("focus",refresh);document.addEventListener("visibilitychange",refresh);
    return()=>{alive=false;clearInterval(timer);clearInterval(clock);window.removeEventListener("focus",refresh);document.removeEventListener("visibilitychange",refresh);};
  },[revision,pages,wallet.address,wallet.chainId]);
  const currentBalances: Record<string,bigint|null> = {};
  if (balances && wallet.address && wallet.chainId===4663 && balances.account===wallet.address) {
    for (const [market,value] of Object.entries(balances.values)) {
      const at=balances.at[market];
      if (at!==undefined && now>=at && now-at<30_000) currentBalances[market]=value;
    }
  }
  return {reads,loading,error,now,address:wallet.address,wrongChain:!!wallet.address&&wallet.chainId!==4663,
    balances:currentBalances, retry:()=>setRevision(r=>r+1),
    loadMore:pages<20 ? ()=>setPages(p=>Math.min(20,p+3)) : null};
}
