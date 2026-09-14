import assert from 'node:assert/strict';
import {test} from 'node:test';
import {forkRunConfig, completeForkRun, forkSuitePath} from './run-isolated-fork.mjs';

test('requires an explicit RPC and positive pinned block', () => {
  assert.throws(() => forkRunConfig({}));
  for(const block of ['', '0', '-1', 'latest', '1.2', '9007199254740992']) {
    assert.throws(() => forkRunConfig({COLLATERAL_RPC_URL:'https://example.invalid',ISOLATED_FORK_BLOCK:block}));
  }
  assert.deepEqual(forkRunConfig({COLLATERAL_RPC_URL:'https://example.invalid',ISOLATED_FORK_BLOCK:'123'}), {rpc:'https://example.invalid',block:'123'});
});
test('only explicit complete market, TWAP and oracle-gap suites can run', () => {
  assert.equal(forkSuitePath(), 'test/fork/DockyardIsolatedMarketsFork.t.sol');
  assert.equal(forkSuitePath('twap'), 'test/fork/DockyardV3TwapFork.t.sol');
  assert.equal(forkSuitePath('gaps'), 'test/fork/DockyardIsolatedOracleGapFork.t.sol');
  assert.equal(forkSuitePath('corroborated-gaps'), 'test/fork/DockyardCorroboratedGapFork.t.sol');
  assert.equal(forkSuitePath('sizing'), 'test/fork/DockyardLiquidationSizingFork.t.sol');
  assert.equal(forkSuitePath('repeated'), 'test/fork/DockyardRepeatedLiquidationFork.t.sol');
  assert.equal(forkSuitePath('controls'), 'test/fork/DockyardCollateralControlsFork.t.sol');
  for (const invalid of ['all', '', 'toString', '__proto__', '../other', null]) assert.throws(() => forkSuitePath(invalid));
});
test('skipped, partially executed and failed fork suites never pass verification', () => {
  assert.equal(completeForkRun('0 passed; 0 failed; 1 skipped',0),false);
  assert.equal(completeForkRun('5 passed; 0 failed; 0 skipped',0),false);
  assert.equal(completeForkRun('6 passed; 0 failed; 0 skipped',1),false);
  assert.equal(completeForkRun('[SKIP] case\n6 passed; 0 failed; 0 skipped',0),false);
  assert.equal(completeForkRun('6 passed; 0 failed; 0 skipped',0),true);
  assert.equal(completeForkRun('16 passed; 0 failed; 0 skipped',0),false);
  assert.equal(completeForkRun('4 passed; 0 failed; 0 skipped',0,4),false);
  assert.equal(completeForkRun('6 passed; 0 failed; 0 skipped',0,4),false);
  assert.equal(completeForkRun('0 passed; 0 failed; 0 skipped',0,0),false);
});
