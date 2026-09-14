import { parseAbi, type Address } from "viem";

/** Draft ABI only. No deployed rewards address is configured. */
export const lenderRewardsAbi = parseAbi([
  "function stakingToken() view returns (address)",
  "function totalStaked() view returns (uint256)",
  "function stakedBalance(address account) view returns (uint256)",
  "function campaign(address rewardToken) view returns ((uint64 startsAt,uint64 endsAt,uint256 funded,uint256 allocated,uint256 claimed))",
  "function earned(address account,address rewardToken) view returns (uint256)",
  "function stake(uint256 shares)",
  "function unstake(uint256 shares)",
  "function claim(address rewardToken)",
  "event Staked(address indexed account,uint256 shares)",
  "event Unstaked(address indexed account,uint256 shares)",
  "event RewardClaimed(address indexed account,address indexed rewardToken,uint256 amount)",
]);

export type LenderRewardsDraft = {
  status: "draft";
  lendingChainId: 4663;
  dock: { address: Address | null; chainId: number | null; reserveBaseUnits: string | null };
  treasury: Address | null;
  reportedReserveBps: 300;
  proposedDurationDays: 30;
  markets: readonly {
    pool: Address;
    rewardsContract: Address | null;
    // Exact token base units, not USD prices or percentages of current supply.
    dockBudgetBaseUnits: string | null;
    usdgBudgetBaseUnits: string | null;
    startsAt: number | null;
    endsAt: number | null;
  }[];
};

/** User-reported 3% holding; token, balance, budgets and dates remain unverified. */
export const lenderRewardsDraft: LenderRewardsDraft = {
  status: "draft",
  lendingChainId: 4663,
  dock: { address: null, chainId: null, reserveBaseUnits: null },
  treasury: null,
  reportedReserveBps: 300,
  proposedDurationDays: 30,
  markets: [],
};

/** Integration seam for Earn/Portfolio. Null means unavailable, not zero earned. */
export function readLenderRewards() {
  return {
    status: "not_configured" as const,
    label: "Lender rewards are not active",
    canStake: false as const,
    canUnstake: false as const,
    canClaim: false as const,
    stakedShares: null,
    claimableDock: null,
    claimableUsdg: null,
    dockPerDay: null,
    usdgSubsidyApr: null,
    endsAt: null,
  };
}

export type LenderRewardsAction =
  | { kind: "stake" | "unstake"; shares: bigint }
  | { kind: "claim"; rewardToken: Address };

/** Never produces approval calldata, invokes a wallet, or starts RPC polling. */
export function prepareLenderRewardsAction(_action: LenderRewardsAction): never {
  throw new Error("Lender rewards are not configured. No transaction was prepared.");
}
