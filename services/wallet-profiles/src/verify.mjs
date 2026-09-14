import { createPublicClient, custom } from 'viem';
import { createReadRpcFallback } from '../../../shared/rpc-fallback.mjs';

/** Only read-only JSON-RPC methods can leave this service. No signer is loaded. */
export function createOwnershipVerifier({ rpcUrl, fallbackRpcUrls = [], chainId = 4663, timeout = 5_000 } = {}) {
  const url = new URL(rpcUrl);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) {
    throw new Error('Profile RPC requires HTTPS or localhost');
  }
  if (chainId !== 4663 && !(chainId === 31337 && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) {
    throw new Error('Unsupported profile verification chain');
  }
  if (chainId === 31337 && fallbackRpcUrls.some(value => !['localhost', '127.0.0.1', '[::1]'].includes(new URL(value).hostname))) {
    throw new Error('Unsupported profile verification chain');
  }
  const rpc = createReadRpcFallback({ urls: [rpcUrl, ...fallbackRpcUrls], chainId, timeoutMs: timeout });
  return async (address, message, signature) => {
    // EVM ecrecover returns address(0) for malformed signatures. The universal
    // verifier must never treat that sentinel as a wallet ownership proof.
    if (typeof address !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(address) || /^0x0{40}$/i.test(address)) return false;
    let failedRpc = false;
    const client = createPublicClient({ transport: custom({ request: async ({ method, params }) => {
      if (!['eth_chainId', 'eth_call'].includes(method)) throw new Error('Profile RPC method forbidden');
      try { return await rpc.request({ method, params }); }
      catch { failedRpc = true; throw new Error('Profile RPC unavailable'); }
    } }, { retryCount: 0 }) });
    if (await client.getChainId() !== chainId) throw new Error('Profile RPC chain mismatch');
    const valid = await client.verifyMessage({ address, message, signature, gas: 500_000n, blockTag: 'latest' });
    // viem 2.31.4 can fall back to ECDSA when eth_call fails. A failed chain read
    // must never become an ownership proof for a delegated/contract account.
    if (failedRpc) throw new Error('Profile RPC unavailable');
    return valid;
  };
}
