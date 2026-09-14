import { encodeFunctionData, type Abi, type Address, type Hash, type Hex, type PublicClient, type WalletClient } from "viem";
import { readRewards, rewardsAbi, shareAbi, type RewardsDeployment } from "./client";

export type RewardAction = "approve" | "stake" | "unstake" | "claim";
export type RewardPending = { action: RewardAction; account: Address; to: Address; data: Hex; afterBlock: string; hash?: Hash; replaced?: boolean };
export const rejected = (error: unknown): boolean => {
  let cause = error;
  for (let i = 0; i < 8 && cause && typeof cause === "object"; i++) {
    if ((cause as { code?: number }).code === 4001) return true;
    cause = (cause as { cause?: unknown }).cause;
  }
  return false;
};

// A mined receipt alone is insufficient: verify the sender and exact reviewed call,
// including zero native-token value. Preserve unknown outcomes for recovery.
export async function settleReward(client: PublicClient, pending: RewardPending, remember: (p: RewardPending | null) => void) {
  if (!pending.hash) throw Error("Enter the transaction hash from your wallet activity.");
  let replacementObserved = false;
  const receipt = await client.waitForTransactionReceipt({ hash: pending.hash, confirmations: 2, timeout: 120000,
    onReplaced: ({ transactionReceipt }) => { replacementObserved = true; remember({ ...pending, hash: transactionReceipt.transactionHash, replaced: true }); },
  });
  const tx = await client.getTransaction({ hash: receipt.transactionHash });
  if (receipt.blockNumber <= BigInt(pending.afterBlock) || tx.from.toLowerCase() !== pending.account.toLowerCase()
    || tx.to?.toLowerCase() !== pending.to.toLowerCase() || tx.input !== pending.data || tx.value !== 0n) {
    if ((replacementObserved || pending.replaced) && receipt.blockNumber > BigInt(pending.afterBlock) && tx.from.toLowerCase() === pending.account.toLowerCase()) {
      remember(null);
      throw Error("The rewards transaction was cancelled or replaced. Reward activation was not completed by this transaction.");
    }
    throw Error("This transaction does not match the reviewed rewards action. Check wallet activity before continuing.");
  }
  remember(null);
  if (receipt.status !== "success") throw Error("The rewards transaction reverted. Your USDG deposit is unchanged. Review and try again.");
  return receipt;
}

export async function sendReward({ client, wallet, deployment, account, action, amount, currentScope, remember, phase }: {
  client: PublicClient; wallet: WalletClient; deployment: RewardsDeployment; account: Address;
  action: RewardAction; amount: bigint; currentScope: () => boolean;
  remember: (p: RewardPending | null) => void; phase: (action: RewardAction) => void;
}) {
  const guard = async () => {
    if (!currentScope() || await wallet.getChainId() !== 4663 || wallet.account?.address.toLowerCase() !== account.toLowerCase()) {
      throw Error("Wallet or network changed. Return to the original wallet to continue.");
    }
  };
  await guard();
  const fresh = await readRewards(client, deployment, account);
  if ((action === "approve" || action === "stake") && (!fresh.acceptingStake || amount <= 0n || fresh.walletShares !== amount)) {
    throw Error("Your share balance or the campaign changed. Review reward activation again.");
  }
  if (action === "stake" && fresh.allowance < amount) throw Error("Share approval is still needed. Continue reward activation.");
  if (action === "unstake" && (amount <= 0n || fresh.staked !== amount)) throw Error("Your activated share balance changed. Review again.");
  const parameters = action === "approve"
    ? { address: deployment.pool, abi: shareAbi, functionName: "approve", args: [deployment.address, amount], account }
    : { address: deployment.address, abi: rewardsAbi, functionName: action, args: action === "claim" ? [] : [amount], account };
  const { request } = await client.simulateContract({ ...parameters, abi: parameters.abi as Abi });
  await guard();
  const pending: RewardPending = { action, account, to: parameters.address, data: encodeFunctionData({ ...parameters, abi: parameters.abi as Abi }), afterBlock: fresh.blockNumber.toString() };
  remember(pending); // Persist before asking the wallet; never retry an ambiguous send.
  phase(action);
  let hash: Hash;
  try { hash = await wallet.writeContract({ ...request, account, chain: wallet.chain }); }
  catch (error) { if (rejected(error)) remember(null); throw error; }
  const submitted = { ...pending, hash };
  remember(submitted);
  return settleReward(client, submitted, remember);
}
