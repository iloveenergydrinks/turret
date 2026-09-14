import { getAddress, type Hash } from 'viem';
import type { CashbackClaim, CashbackConfig } from './client';

export type Recovery = { claims: CashbackClaim[]; pending: { claim: CashbackClaim; hash?: Hash } | null };
export const recoveryKey = (config: CashbackConfig, account: string) =>
  `turret:borrower-cashback:${config.chainId}:${config.deployment?.address.toLowerCase()}:${account.toLowerCase()}`;
const hash = (value: unknown): Hash => {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(value)) throw new Error('Invalid saved claim hash');
  return value as Hash;
};
function claim(value: unknown, owner: string): CashbackClaim {
  if (!value || typeof value !== 'object') throw new Error('Invalid saved claim');
  const v = value as Record<string, unknown>;
  if (typeof v.borrower !== 'string' || getAddress(v.borrower) !== getAddress(owner) || typeof v.engine !== 'string'
    || typeof v.cumulative !== 'string' || !/^[1-9][0-9]{0,77}$/.test(v.cumulative)
    || BigInt(v.cumulative) >= 2n ** 256n || !Array.isArray(v.proof) || v.proof.length > 64)
    throw new Error('Invalid saved claim beneficiary or amount');
  return { borrower: getAddress(owner), engine: getAddress(v.engine), cumulative: BigInt(v.cumulative),
    root: hash(v.root), proof: v.proof.map(hash) };
}
export function encodeRecovery(config: CashbackConfig, owner: string, value: Recovery): string {
  return JSON.stringify({ scope: recoveryKey(config, owner), ...value }, (_, v) => typeof v === 'bigint' ? v.toString() : v);
}
export function decodeRecovery(config: CashbackConfig, owner: string, raw: string): Recovery {
  if (raw.length > 100000) throw new Error('Saved claim data is too large');
  const value = JSON.parse(raw);
  if (value.scope !== recoveryKey(config, owner) || !Array.isArray(value.claims) || value.claims.length > 64)
    throw new Error('Saved claim scope mismatch');
  const claims = value.claims.map((v: unknown) => claim(v, owner));
  const pending = value.pending === null ? null : { claim: claim(value.pending.claim, owner),
    ...(value.pending.hash ? { hash: hash(value.pending.hash) } : {}) };
  return { claims, pending };
}
