import { spawnSync } from 'node:child_process';
import { mkdirSync, openSync, closeSync, readdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, join } from 'node:path';

// Local tests only. Integration mode starts ephemeral loopback Anvil chains.
const root = fileURLToPath(new URL('../../', import.meta.url));
const contracts = join(root, 'contracts');
const worker = join(root, 'services/liquidator');
const flags = new Set(process.argv.slice(2));
if ([...flags].some(flag => !['--findings', '--integration'].includes(flag))) {
  console.error('Usage: node contracts/security/run-dockyard-stress.mjs [--findings] [--integration]');
  process.exit(2);
}
const output = resolve(root, process.env.DOCKYARD_STRESS_OUTPUT ?? 'output/dockyard-stress-run');
mkdirSync(output, { recursive: true });
const results = [];
function run(name, executable, args, cwd, extraEnv = {}) {
  const path = join(output, `${name}.txt`);
  const fd = openSync(path, 'w');
  let result;
  try {
    result = spawnSync(executable, args, {
      cwd, env: { ...process.env, ...extraEnv }, stdio: ['ignore', fd, fd],
    });
  } finally { closeSync(fd); }
  const entry = { name, executable, args, cwd, exitCode: result.status, signal: result.signal,
    error: result.error?.message, log: path };
  results.push(entry);
  console.log(`${name}: ${result.status === 0 ? 'PASS' : 'FAIL'} — ${path}`);
}
const forge = ['test', '--skip', 'script', '--fuzz-seed', '0x20260905', '-v'];
if (flags.has('--findings')) {
  // Focused permanent regressions. Run both even if one fails.
  run('oracle-findings', 'forge', [...forge, '--match-path', 'test/security/DockyardOracleStress.t.sol',
    '--match-test', 'Repro', '--fuzz-runs', '1'], contracts);
  run('worker-findings', process.execPath, ['--test', '--test-name-pattern=FINDING',
    'test/dockyard-stress-keeper.test.mjs'], worker);
} else {
  run('oracle-stress', 'forge', [...forge, '--match-path', 'test/security/DockyardOracleStress.t.sol',
    '--fuzz-runs', '10000'], contracts);
  run('liquidation-stress', 'forge', [...forge, '--match-path',
    'test/security/Dockyard{Liquidation,FrozenCashcat}Stress.t.sol', '--fuzz-runs', '1024'], contracts);
  run('accounting-invariants', 'forge', [...forge, '--match-contract', '^DockyardIsolatedInvariantTest$'], contracts,
    { FOUNDRY_INVARIANT_RUNS: '1000', FOUNDRY_INVARIANT_DEPTH: '200' });
  const unitTests = readdirSync(join(worker, 'test')).filter(name => name.endsWith('.test.mjs'))
    .sort().map(name => `test/${name}`);
  run('worker-tests', process.execPath, ['--test', ...unitTests], worker);
  console.log('All original findings are enforced as permanent regressions in every mode.');
}
if (flags.has('--integration')) {
  run('worker-evm-integration', process.execPath, ['--test', 'test/isolated.integration.mjs',
    'test/stock-isolated.integration.mjs'], worker);
}
writeFileSync(join(output, 'results.json'), JSON.stringify({ createdAt: new Date().toISOString(), results }, null, 2));
process.exitCode = results.some(result => result.exitCode !== 0) ? 1 : 0;
