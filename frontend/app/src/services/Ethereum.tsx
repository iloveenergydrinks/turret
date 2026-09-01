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

export const wagmiConfig = createConfig({
  chains: [dockyardChain],
  connectors: [
    injected(),
    coinbaseWallet({ appName: content.appName }),
  ],
  ssr: true,
  transports: { [CHAIN_ID]: http(CHAIN_RPC_URL) },
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
        options={{
          avoidLayoutShift: true,
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
