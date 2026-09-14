import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

export function forkRunConfig(env) {
  const rpc = env.COLLATERAL_RPC_URL ?? env.ISOLATED_FORK_RPC_URL;
  const block = env.ISOLATED_FORK_BLOCK;
  if (!rpc || !/^https?:$/.test(new URL(rpc).protocol)) throw new Error('An explicit HTTP RPC is required');
  if (!block || !/^[1-9][0-9]*$/.test(block) || !Number.isSafeInteger(Number(block))) {
    throw new Error('An explicit positive pinned block is required');
  }
  return { rpc, block };
}

export function completeForkRun(output, exitCode, expected = 6) {
  // Only known complete suites are accepted. A skipped setUp is not proof.
  if (expected !== 6) return false;
  return exitCode === 0 && new RegExp(`(?:^|\\s)${expected} passed; 0 failed; 0 skipped`).test(output) && !/\[SKIP/.test(output);
}

export function forkSuitePath(suite = 'markets') {
  const paths = new Map([
    ['markets', 'test/fork/DockyardIsolatedMarketsFork.t.sol'],
    ['twap', 'test/fork/DockyardV3TwapFork.t.sol'],
    ['gaps', 'test/fork/DockyardIsolatedOracleGapFork.t.sol'],
    ['corroborated-gaps', 'test/fork/DockyardCorroboratedGapFork.t.sol'],
    ['sizing', 'test/fork/DockyardLiquidationSizingFork.t.sol'],
    ['repeated', 'test/fork/DockyardRepeatedLiquidationFork.t.sol'],
    ['controls', 'test/fork/DockyardCollateralControlsFork.t.sol'],
  ]);
  if (!paths.has(suite)) throw new Error('Unknown fork suite');
  return paths.get(suite);
}

export async function main(env = process.env) {
  const { rpc, block } = forkRunConfig(env);
  const suite = env.ISOLATED_FORK_SUITE ?? 'markets';
  const expected = 6;
  const path = forkSuitePath(suite);
  console.log(`Running ${expected} ${suite} tests on a read-only fork at block ${block}. No broadcast.`);
  const child = spawn('forge', ['test', '--skip', 'script', '--match-path', path, '-vv'], {
    cwd: fileURLToPath(new URL('../', import.meta.url)),
    env: { ...env, ISOLATED_FORK_RPC_URL: rpc, ISOLATED_FORK_BLOCK: block },
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const code = await new Promise((resolve, reject) => { child.on('close', resolve); child.on('error', reject); });
  const url = new URL(rpc);
  const secrets = [rpc, url.pathname.split('/').at(-1), ...url.searchParams.values()].filter(s => s && s.length >= 8);
  let sanitized = output;
  for (const secret of secrets) sanitized = sanitized.split(secret).join('[REDACTED_RPC]');
  process.stdout.write(sanitized);
  if (!completeForkRun(output, code, expected)) throw new Error('Fork suite did not execute and pass all expected cases');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { console.error('Fork verification failed or was incomplete. No transaction was broadcast.'); process.exitCode = 1; });
}
