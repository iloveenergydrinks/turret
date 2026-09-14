"use client";

import type { ReactNode } from "react";

import content from "@/src/content";
import {
  CHAIN_BLOCK_EXPLORER,
  CHAIN_CONTRACT_ENS_REGISTRY,
  CHAIN_CONTRACT_ENS_RESOLVER,
  CHAIN_CONTRACT_MULTICALL,
  CHAIN_CURRENCY,
  CHAIN_ID,
  CHAIN_NAME,
  CHAIN_RPC_URL,
  DEFAULT_CHAIN_RPC_URL,
} from "@/src/env";
import { blo } from "blo";
import { ConnectKitProvider } from "connectkit";
import Image from "next/image";
import { createConfig, http, WagmiProvider } from "wagmi";
import { coinbaseWallet, injected } from "wagmi/connectors";

const dockyardChain = {
  id: CHAIN_ID,
  name: CHAIN_NAME,
  nativeCurrency: CHAIN_CURRENCY,
  rpcUrls: {
    default: { http: [CHAIN_RPC_URL] },
  },
  blockExplorers: CHAIN_BLOCK_EXPLORER
    ? { default: CHAIN_BLOCK_EXPLORER }
    : undefined,
  contracts: {
    ensRegistry: CHAIN_CONTRACT_ENS_REGISTRY ?? undefined,
    ensUniversalResolver: CHAIN_CONTRACT_ENS_RESOLVER ?? undefined,
    multicall3: { address: CHAIN_CONTRACT_MULTICALL },
  },
} as const;

// Keep the public URL in wallet network metadata. Only app requests use the
// same-origin server; explicit user RPC overrides retain their chosen endpoint.
const useRpcProxy = CHAIN_ID === 4663 && CHAIN_RPC_URL === DEFAULT_CHAIN_RPC_URL
  && process.env.NODE_ENV === "production" && typeof window !== "undefined";
const appRpcUrl = useRpcProxy
  ? new URL("/api/rpc", window.location.origin).href
  : CHAIN_RPC_URL;

export const wagmiConfig = createConfig({
  chains: [dockyardChain],
  connectors: [
    // Explicit entry also works when a mobile browser has no injected wallet.
    injected({ target: "metaMask" }),
    injected(),
    coinbaseWallet({ appName: content.appName, overrideIsMetaMask: false }),
  ],
  ssr: true,
  transports: { [CHAIN_ID]: http(appRpcUrl, {
    // Portfolio reads many contracts together. Match the server's batch limit.
    batch: useRpcProxy ? { batchSize: 50, wait: 10 } : false,
  }) },
});

export function Ethereum({
  children,
}: {
  children: ReactNode;
}) {
  return (
    <WagmiProvider config={wagmiConfig}>
      <ConnectKitProvider
        mode="light"
        customTheme={{"--ck-font-family": "system-ui, sans-serif", "--ck-border-radius": "16px", "--ck-primary-button-border-radius": "999px", "--ck-secondary-button-border-radius": "999px", "--ck-connectbutton-border-radius": "999px", "--ck-body-color": "#292524", "--ck-body-color-muted": "#57534e", "--ck-body-background": "#ffffff", "--ck-body-background-secondary": "#f5f5f4", "--ck-body-action-color": "#292524", "--ck-focus-color": "#57534e", "--ck-overlay-background": "rgba(25,25,29,0.48)"}}
        options={{
          avoidLayoutShift: true,
          disableEns: CHAIN_ID !== 1,
          customAvatar: ({ address, size }) => (
            address && (
              <Image
                alt={address}
                src={blo(address)}
                width={size}
                height={size}
              />
            )
          ),
          embedGoogleFonts: false,
          hideBalance: true,
          hideQuestionMarkCTA: true,
          hideRecentBadge: true,
          language: "en-US",
          overlayBlur: 0,
          reducedMotion: true,
          walletConnectCTA: "link",
          walletConnectName: "WalletConnect",
        }}
      >
        {children}
      </ConnectKitProvider>
    </WagmiProvider>
  );
}
