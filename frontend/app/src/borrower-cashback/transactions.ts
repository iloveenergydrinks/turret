import { decodeEventLog, encodeFunctionData, erc20Abi, getAddress, keccak256, parseAbi,
  type Address, type Hash, type PublicClient, type WalletClient } from 'viem';
import type { CashbackClaim, CashbackConfig } from './client';

export const cashbackAbi = parseAbi([
  'function claim(bytes32 root,address borrower,address engine,uint256 cumulative,bytes32[] proof)',
  'function claimed(address borrower,address engine) view returns(uint256)',
  'function rewardToken() view returns(address)',
]);
const args = (claim: CashbackClaim) => [claim.root, claim.borrower, claim.engine, claim.cumulative, claim.proof] as const;
type ClaimInput = { client: PublicClient; config: CashbackConfig; claim: CashbackClaim; account: Address };
export class CashbackAlreadyClaimed extends Error {
  constructor() { super('This cashback has already been claimed'); }
}
export class CashbackClaimReverted extends Error {
  constructor() { super('Cashback claim reverted. No cashback was paid by this transaction.'); }
}

async function verifyDeployment({ client, config, claim, account }: ClaimInput) {
  if (!config.deployment || getAddress(claim.borrower) !== getAddress(account)) throw new Error('Claim belongs to another wallet');
  if (await client.getChainId() !== config.chainId) throw new Error('Switch to the cashback campaign network');
  const address = getAddress(config.deployment.address);
  const code = await client.getCode({ address });
  if (!code || keccak256(code) !== config.deployment.runtimeHash) throw new Error('Cashback contract could not be verified');
  const token = await client.readContract({ address, abi: cashbackAbi, functionName: 'rewardToken' });
  if (getAddress(token) !== getAddress(config.rewardToken)) throw new Error('Cashback token mismatch');
  return address;
}

/** Claims use only the pinned distributor. The API never supplies a transaction target or calldata. */
export async function previewCashbackClaim(input: ClaimInput): Promise<bigint> {
  const address = await verifyDeployment(input);
  const claimed = await input.client.readContract({ address, abi: cashbackAbi, functionName: 'claimed',
    args: [input.account, input.claim.engine] });
  if (claimed >= input.claim.cumulative) throw new CashbackAlreadyClaimed();
  await input.client.simulateContract({ address, abi: cashbackAbi, functionName: 'claim',
    args: args(input.claim), account: input.account });
  return input.claim.cumulative - claimed;
}

export async function submitCashbackClaim(input: ClaimInput & { wallet: WalletClient }): Promise<Hash> {
  const address = await verifyDeployment(input);
  if (await input.wallet.getChainId() !== input.config.chainId
    || !(await input.wallet.getAddresses()).some(a => getAddress(a) === getAddress(input.account)))
    throw new Error('Reconnect the enrolled wallet on the campaign network');
  const { request } = await input.client.simulateContract({ address, abi: cashbackAbi, functionName: 'claim',
    args: args(input.claim), account: input.account });
  return input.wallet.writeContract({ ...request, account: input.account, chain: input.wallet.chain });
}

/** Used both after submission and on reload. A wallet signature is never treated as a paid reward. */
export async function verifyCashbackClaim(input: ClaimInput & { hash: Hash }): Promise<{ hash: Hash; received: bigint }> {
  const address = await verifyDeployment(input);
  const receipt = await input.client.getTransactionReceipt({ hash: input.hash });
  const transaction = await input.client.getTransaction({ hash: input.hash });
  if (transaction.to?.toLowerCase() !== address.toLowerCase() || getAddress(transaction.from) !== getAddress(input.account)
    || transaction.input !== encodeFunctionData({ abi: cashbackAbi, functionName: 'claim', args: args(input.claim) }))
    throw new Error('Transaction does not match the reviewed cashback claim');
  if (receipt.status !== 'success') throw new CashbackClaimReverted();
  let received = 0n;
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== input.config.rewardToken.toLowerCase()) continue;
    try {
      const event = decodeEventLog({ abi: erc20Abi, data: log.data, topics: log.topics });
      if (event.eventName === 'Transfer' && event.args.from.toLowerCase() === address.toLowerCase()
        && getAddress(event.args.to) === getAddress(input.account)) received += event.args.value;
    } catch { /* Other token events do not demonstrate payment. */ }
  }
  const claimed = await input.client.readContract({ address, abi: cashbackAbi, functionName: 'claimed',
    args: [input.account, input.claim.engine], blockNumber: receipt.blockNumber });
  if (received <= 0n || received > input.claim.cumulative || claimed < input.claim.cumulative)
    throw new Error('Receipt does not confirm the expected USDG payout');
  return { hash: input.hash, received };
}
