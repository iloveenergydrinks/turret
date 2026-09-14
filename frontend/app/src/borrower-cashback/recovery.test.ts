import { expect, test } from 'vitest';
import { encodeRecovery, decodeRecovery } from './recovery';
const owner = '0x1111111111111111111111111111111111111111';
const engine = '0x2222222222222222222222222222222222222222';
const config = { chainId: 4663, rewardToken: engine, deployment: { address: engine, runtimeHash: `0x${'a'.repeat(64)}` } };
const claim = { borrower: owner, engine, cumulative: 500000n, root: `0x${'b'.repeat(64)}`, proof: [] } as const;
test('saved claims preserve exact amounts and cannot be restored in another wallet or deployment', () => {
  const raw = encodeRecovery(config, owner, { claims: [{ ...claim, proof: [] }], pending: null });
  expect(decodeRecovery(config, owner, raw).claims[0]?.cumulative).toBe(500000n);
  expect(() => decodeRecovery(config, engine, raw)).toThrow();
  expect(() => decodeRecovery({ ...config, chainId: 1 }, owner, raw)).toThrow();
  expect(() => decodeRecovery({ ...config, deployment: { ...config.deployment, address: owner } }, owner, raw)).toThrow();
});
test('pending wallet requests survive reload before and after a transaction hash is known', () => {
  for (const pending of [{ claim:{...claim,proof:[]} }, { claim:{...claim,proof:[]},hash:`0x${'c'.repeat(64)}` as `0x${string}` }]) {
    const restored=decodeRecovery(config,owner,encodeRecovery(config,owner,{claims:[],pending}));
    expect(restored.pending?.claim.cumulative).toBe(500000n);
    expect(restored.pending?.hash).toBe('hash' in pending ? pending.hash : undefined);
  }
});
test('tampered beneficiary, malformed proof and oversized data cannot become a wallet request', () => {
  const value=JSON.parse(encodeRecovery(config,owner,{claims:[{...claim,proof:[]}],pending:null}));
  value.claims[0].borrower=engine;
  expect(()=>decodeRecovery(config,owner,JSON.stringify(value))).toThrow();
  value.claims[0].borrower=owner;value.claims[0].proof=['javascript:alert(1)'];
  expect(()=>decodeRecovery(config,owner,JSON.stringify(value))).toThrow();
  expect(()=>decodeRecovery(config,owner,'x'.repeat(100001))).toThrow();
});
