import { decodeFunctionData, encodeFunctionData, type Abi, type Address, type Hash, type Hex, type PublicClient, type WalletClient } from "viem";
import { readStaking, stakingAbi, tokenAbi, TURRET, STAKING_CHAIN_ID, type StakingDeployment } from "./client";
export type StakingAction = "approve" | "stake" | "unstake" | "claim";
export type StakingStage = "checking" | "wallet" | "confirming";
export type StakingPending = {
  action: StakingAction; account: Address; to: Address; data: Hex; afterBlock: string;
  chainId: number; staking: Address; hash?: Hash; replaced?: boolean;
};
export const rejected = (error: unknown): boolean => {
  let cause = error;
  for (let i = 0; i < 8 && cause && typeof cause === "object"; i++) {
    if ((cause as { code?: number }).code === 4001) return true;
    cause = (cause as { cause?: unknown }).cause;
  }
  return false;
};

// Validate persisted browser data before treating it as a recoverable financial action.
export function parsePending(raw: string, d: StakingDeployment, account: Address): StakingPending {
  const p = JSON.parse(raw) as StakingPending;
  const address = /^0x[\da-f]{40}$/i, hash = /^0x[\da-f]{64}$/i;
  if (!p || !["approve", "stake", "unstake", "claim"].includes(p.action) || !address.test(p.account)
    || p.account.toLowerCase() !== account.toLowerCase() || p.chainId !== STAKING_CHAIN_ID
    || typeof p.staking !== "string" || p.staking.toLowerCase() !== d.address.toLowerCase()
    || !address.test(p.to) || !/^\d+$/.test(p.afterBlock) || !/^0x(?:[\da-f]{2})*$/i.test(p.data)
    || (p.hash !== undefined && !hash.test(p.hash))) throw Error("Saved transaction details are invalid. Check wallet activity before continuing.");
  const target = p.action === "approve" ? TURRET : d.address;
  const abi = p.action === "approve" ? tokenAbi : stakingAbi;
  const decoded = decodeFunctionData({ abi, data: p.data });
  const args = decoded.args as readonly unknown[] | undefined;
  if (p.to.toLowerCase() !== target.toLowerCase() || decoded.functionName !== p.action
    || (p.action === "approve" && String(args?.[0]).toLowerCase() !== d.address.toLowerCase())) {
    throw Error("Saved transaction does not match this staking deployment.");
  }
  return p;
}

export async function settleStaking(client: PublicClient, p: StakingPending, remember: (p: StakingPending | null) => void) {
  if (!p.hash || !/^0x[\da-f]{64}$/i.test(p.hash)) throw Error("Enter the transaction hash from your wallet activity.");
  if (await client.getChainId() !== STAKING_CHAIN_ID) throw Error("Switch to Robinhood Chain to check this transaction.");
  let replacementObserved = false;
  const receipt = await client.waitForTransactionReceipt({ hash: p.hash, confirmations: 2, timeout: 60_000,
    onReplaced: ({ transactionReceipt }) => { replacementObserved = true; remember({ ...p, hash: transactionReceipt.transactionHash, replaced: true }); },
  });
  const tx = await client.getTransaction({ hash: receipt.transactionHash });
  if (receipt.blockNumber <= BigInt(p.afterBlock) || tx.from.toLowerCase() !== p.account.toLowerCase()
    || tx.to?.toLowerCase() !== p.to.toLowerCase() || tx.input.toLowerCase() !== p.data.toLowerCase() || tx.value !== 0n) {
    if ((replacementObserved || p.replaced) && receipt.blockNumber > BigInt(p.afterBlock) && tx.from.toLowerCase() === p.account.toLowerCase()) {
      remember(null); throw Error("The staking transaction was cancelled or replaced. Review balances before continuing.");
    }
    throw Error("This transaction does not match the reviewed staking action. Check the hash in your wallet.");
  }
  remember(null);
  if (receipt.status !== "success") throw Error("The staking transaction reverted. Refresh balances and review again.");
  return receipt;
}

export async function sendStaking({ client, wallet, deployment: d, account, action, amount, currentScope, remember, onStage }: {
  client: PublicClient; wallet: WalletClient; deployment: StakingDeployment; account: Address;
  action: StakingAction; amount: bigint; currentScope: () => boolean; remember: (p: StakingPending | null) => void;
  onStage?: (stage: StakingStage) => void;
}) {
  onStage?.("checking");
  const guard = async () => {
    if (!currentScope() || await wallet.getChainId() !== STAKING_CHAIN_ID || wallet.account?.address.toLowerCase() !== account.toLowerCase()
      || (await wallet.getAddresses())[0]?.toLowerCase() !== account.toLowerCase()) {
      throw Error("Wallet or network changed. Review again using the original wallet.");
    }
  };
  if (d.legacy && (action === "approve" || action === "stake")) throw Error("Legacy staking supports withdrawals and claims only.");
  await guard();
  const fresh = await readStaking(client, d, account);
  if ((action === "approve" || action === "stake") && (amount <= 0n || amount > fresh.walletBalance)) throw Error("Your TURRET balance changed. Review the amount again.");
  if (action === "stake" && fresh.allowance < amount) throw Error("Approve this TURRET amount before staking.");
  if (action === "unstake" && (amount <= 0n || amount > fresh.staked)) throw Error("Your staked balance changed. Review the withdrawal again.");
  if (action === "unstake" && !fresh.canUnstake) throw Error("Wait for the withdrawal delay after staking, then refresh before withdrawing.");
  if (action === "claim" && fresh.earned === 0n) throw Error("No USDG is currently claimable. Refresh rewards.");
  const parameters = action === "approve"
    ? { address: TURRET, abi: tokenAbi as Abi, functionName: "approve", args: [d.address, amount], account }
    : { address: d.address, abi: stakingAbi as Abi, functionName: action, args: action === "claim" ? [] : [amount], account };
  const { request } = await client.simulateContract(parameters);
  await guard();
  const pending: StakingPending = { action, account, to: parameters.address, data: encodeFunctionData(parameters),
    afterBlock: fresh.blockNumber.toString(), chainId: STAKING_CHAIN_ID, staking: d.address };
  remember(pending);
  let hash: Hash;
  onStage?.("wallet");
  try { hash = await wallet.writeContract({ ...request, account, chain: wallet.chain }); }
  catch (error) { if (rejected(error)) remember(null); throw error; }
  const submitted = { ...pending, hash };
  remember(submitted);
  onStage?.("confirming");
  return settleStaking(client, submitted, remember);
}
