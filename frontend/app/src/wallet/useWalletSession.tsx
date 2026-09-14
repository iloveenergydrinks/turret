import { useEffect, useState, type ReactNode } from "react";
import type { Address, EIP1193Provider } from "viem";
import { createConfig, http, useAccount, useDisconnect, WagmiProvider } from "wagmi";
import { coinbaseWallet, injected } from "wagmi/connectors";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ConnectKitProvider, useModal } from "connectkit";
import { WalletAvatar } from "../profiles/WalletAvatar";

const chain = {
  id: 4663,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.mainnet.chain.robinhood.com/"] } },
} as const;
const rpc = typeof window === "undefined" ? chain.rpcUrls.default.http[0] : new URL("/api/rpc", window.location.origin).href;
const config = createConfig({
  chains: [chain],
  connectors: [injected({ target: "metaMask" }), injected(), coinbaseWallet({ appName: "Turret", overrideIsMetaMask: false })],
  transports: { 4663: http(rpc, { batch: { batchSize: 50, wait: 8 }, retryCount: 1 }) },
  ssr: false,
});
const queries = new QueryClient({ defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } } });

export function WalletSessionProvider({ children }: { children: ReactNode }) {
  return <WagmiProvider config={config}><QueryClientProvider client={queries}>
    <ConnectKitProvider mode="light" customTheme={{
      "--ck-font-family": "system-ui, sans-serif", "--ck-border-radius": "16px",
      "--ck-primary-button-border-radius": "999px", "--ck-body-background": "#ffffff",
      "--ck-body-color": "#292524", "--ck-body-background-secondary": "#f5f5f4",
    }} options={{ avoidLayoutShift: true, disableEns: true, embedGoogleFonts: false, hideBalance: true,
      hideQuestionMarkCTA: true, hideRecentBadge: true, reducedMotion: true,
      customAvatar: ({ address, size }) => address ? <WalletAvatar address={address} size={size} /> : null,
    }}>{children}</ConnectKitProvider>
  </QueryClientProvider></WagmiProvider>;
}

export function useWalletSession(): {
  account: Address | null; chainId: number | null; provider: EIP1193Provider | null;
  connecting: boolean; error: string | null; connect: () => Promise<void>; disconnect: () => void;
} {
  const wallet = useAccount();
  const { disconnect } = useDisconnect();
  const { setOpen } = useModal();
  const [provider, setProvider] = useState<{ address: string; chainId: number | undefined; connector: unknown; value: EIP1193Provider } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    setError(null);
    if (!wallet.address || !wallet.connector) { setProvider(null); return; }
    const address = wallet.address, chainId = wallet.chainId, connector = wallet.connector;
    void connector.getProvider().then((value) => {
      if (active && value && typeof value === "object" && "request" in value) {
        setProvider({ address, chainId, connector, value: value as EIP1193Provider });
      }
    }).catch(() => { if (active) setError("Unable to reach your wallet. Reconnect to continue."); });
    return () => { active = false; };
  }, [wallet.address, wallet.chainId, wallet.connector]);
  return {
    account: wallet.address ?? null, chainId: wallet.chainId ?? null,
    provider: provider && provider.address === wallet.address && provider.chainId === wallet.chainId && provider.connector === wallet.connector ? provider.value : null,
    connecting: wallet.isConnecting || wallet.isReconnecting, error,
    connect: async () => { setError(null); setOpen(true); },
    disconnect: () => { setProvider(null); disconnect(); },
  };
}
