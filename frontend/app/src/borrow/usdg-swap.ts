import { formatUnits } from 'viem';
export const SWAP_USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';
/** Verified against Uniswap's live swap form; amount denotes USDG on the chosen side. */
export function usdgSwapLink(direction: 'get' | 'swap', amount: bigint, other = 'ETH'): string {
 if (amount < 0n || amount >= 2n ** 256n || !(other === 'ETH' || /^0x[0-9a-f]{40}$/i.test(other)) || other.toLowerCase() === SWAP_USDG.toLowerCase()) throw Error('Invalid swap request');
 const query = new URLSearchParams({chain:'robinhood', inputCurrency:direction === 'get' ? other : SWAP_USDG, outputCurrency:direction === 'get' ? SWAP_USDG : other});
 if (amount > 0n) { query.set('field', direction === 'get' ? 'output' : 'input'); query.set('value', formatUnits(amount,6)); }
 return 'https://app.uniswap.org/swap?' + query.toString();
}
