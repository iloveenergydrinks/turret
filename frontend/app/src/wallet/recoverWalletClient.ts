import type { WalletClient } from 'viem';

export type RefreshWalletClient = () => Promise<{ data?: WalletClient }>;
export const WALLET_CONNECTION_ERROR = 'Could not connect to your wallet. Unlock MetaMask and try again, or reconnect using the wallet menu.';

// Resolve only after an explicit user action. Callers must hold their transaction
// lock and recheck their review scope after this asynchronous connection step.
export async function recoverWalletClient(wallet?: WalletClient, refresh?: RefreshWalletClient): Promise<WalletClient> {
  if (wallet) return wallet;
  try {
    const recovered = (await refresh?.())?.data;
    if (recovered) return recovered;
  } catch {
    // A failed connector read has not submitted a transaction.
  }
  throw new Error(WALLET_CONNECTION_ERROR);
}
