import { getAddress, isHex, type Address, type Hex } from 'viem';
import { quoteCashback, type CashbackCampaign } from '../../../../shared/borrower-cashback.mjs';

export type CashbackConfig = { chainId: number; rewardToken: string;
  deployment: { address: string; runtimeHash: string; publicEnrollment?: boolean } | null };
export type CashbackClaim = { root: Hex; borrower: Address; engine: Address; cumulative: bigint; proof: Hex[] };
export type CashbackAccount = {
  borrower: Address; engine: Address; startsAt: number; cap: bigint; principal: bigint; eligiblePrincipal: bigint;
  unpaidInterest: bigint; estimatedRebate: bigint | null; confirmedRebate: bigint; committedRebate: bigint | null;
  claimed: bigint; claimable: bigint; claim: CashbackClaim | null;
};
export type CashbackResponse = {
  campaign: CashbackCampaign; accounts: CashbackAccount[]; fresh: boolean;
  asOf: { number: number; hash: Hex; timestamp: number }; enrollmentPaused: boolean;
  totalFunded: bigint; totalCommitted: bigint;
  publicEnrollment: {walletCap:bigint;budgetCap:bigint} | null; joined:boolean | null;
};
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid rewards response');
  return value as Record<string, unknown>;
};
const integer = (value: unknown) => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error('Invalid reward time');
  return value;
};
const units = (value: unknown) => {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,77})$/.test(value) || BigInt(value) >= 2n ** 256n)
    throw new Error('Invalid reward amount');
  return BigInt(value);
};
const address = (value: unknown) => {
  if (typeof value !== 'string') throw new Error('Invalid reward address');
  return getAddress(value);
};
const hash = (value: unknown): Hex => {
  if (typeof value !== 'string' || !isHex(value, { strict: true }) || value.length !== 66) throw new Error('Invalid proof hash');
  return value;
};

export async function readCashback(config: CashbackConfig, borrower: string, signal?: AbortSignal): Promise<CashbackResponse | null> {
  if (!config.deployment) return null;
  const owner = address(borrower);
  const response = await fetch(`/api/borrower-cashback/v1/rewards/${owner}`, { signal, cache: 'no-store' });
  if (!response.ok) throw new Error('Cashback information is unavailable');
  const data = object(await response.json());
  if (data.status !== 'ready' || data.chainId !== config.chainId
    || address(data.distributor) !== address(config.deployment.address) || address(data.rewardToken) !== address(config.rewardToken))
    throw new Error('Cashback deployment mismatch');
  const c = object(data.campaign);
  const campaign = { startsAt: integer(c.startsAt), endsAt: integer(c.endsAt), settlementDeadline: integer(c.settlementDeadline),
    claimDeadline: integer(c.claimDeadline), rebateBps: integer(c.rebateBps) };
  quoteCashback({ principal: 0n, aprBps: 0, now: campaign.startsAt, days: 0, campaign });
  const block = object(data.asOf);
  const asOf = { number: integer(block.number), hash: hash(block.hash), timestamp: integer(block.timestamp) };
  if (typeof data.fresh !== 'boolean' || typeof data.enrollmentPaused !== 'boolean' || !Array.isArray(data.accounts)
    || data.accounts.length > 64) throw new Error('Invalid reward accounts');
  const totalFunded = units(data.totalFunded), totalCommitted = units(data.totalCommitted);
  if (totalCommitted > totalFunded) throw new Error('Campaign commitments exceed funding');
  let publicEnrollment: CashbackResponse['publicEnrollment'] = null;
  if (config.deployment.publicEnrollment) {
    const publicPolicy = object(data.publicEnrollment);
    publicEnrollment = {walletCap:units(publicPolicy.walletCap),budgetCap:units(publicPolicy.budgetCap)};
    if (publicEnrollment.walletCap !== 25_000000n || publicEnrollment.budgetCap !== 1000_000000n
      || totalFunded > publicEnrollment.budgetCap || typeof data.joined !== 'boolean') throw new Error('Invalid public enrollment');
  } else if (data.publicEnrollment) throw new Error('Unexpected public campaign');
  const seen = new Set<string>();
  const accounts = data.accounts.map((value): CashbackAccount => {
    const row = object(value), engine = address(row.engine);
    if (address(row.borrower) !== owner || seen.has(engine)) throw new Error('Reward account mismatch');
    seen.add(engine);
    const account = { borrower: owner, engine, startsAt: integer(row.startsAt), cap: units(row.cap),
      principal: units(row.principal), eligiblePrincipal: units(row.eligiblePrincipal), unpaidInterest: units(row.unpaidInterest),
      estimatedRebate: row.estimatedRebate === null ? null : units(row.estimatedRebate),
      confirmedRebate: units(row.confirmedRebate), committedRebate: row.committedRebate === null ? null : units(row.committedRebate),
      claimed: units(row.claimed), claimable: units(row.claimable), claim: null as CashbackClaim | null };
    if (account.cap <= 0n || account.confirmedRebate > account.cap || account.claimed > account.cap
      || account.eligiblePrincipal > account.principal || account.startsAt < campaign.startsAt || account.startsAt >= campaign.endsAt
      || (account.committedRebate !== null && account.committedRebate > account.cap)) throw new Error('Invalid reserved reward');
    if (row.claim !== null) {
      const proof = object(row.claim);
      if (address(proof.borrower) !== owner || address(proof.engine) !== engine || !Array.isArray(proof.proof)
        || proof.proof.length > 64) throw new Error('Claim beneficiary mismatch');
      account.claim = { root: hash(proof.root), borrower: owner, engine, cumulative: units(proof.cumulative), proof: proof.proof.map(hash) };
      if (account.claim.cumulative > account.cap || account.claim.cumulative <= account.claimed
        || account.claim.cumulative - account.claimed !== account.claimable) throw new Error('Claim amount mismatch');
    } else if (account.claimable !== 0n) throw new Error('Claim has no proof');
    return account;
  });
  if (!publicEnrollment && accounts.reduce((sum, account) => sum + account.cap, 0n) > totalCommitted) throw new Error('Unfunded enrollment');
  if (publicEnrollment) {
    if (accounts.some(row=>row.cap !== publicEnrollment!.walletCap) || (accounts.length>0 && data.joined !== true)
      || (data.joined && totalCommitted < publicEnrollment.walletCap)) throw new Error('Public enrollment mismatch');
    for (const field of ['confirmedRebate','claimed','committedRebate'] as const)
      if (accounts.reduce((sum,row)=>sum+(row[field]??0n),0n)>publicEnrollment.walletCap) throw new Error('Wallet reward exceeds cap');
  }
  return { campaign, accounts, asOf, fresh: data.fresh, enrollmentPaused: data.enrollmentPaused, totalFunded, totalCommitted,
    publicEnrollment, joined:publicEnrollment ? data.joined as boolean : null };
}
