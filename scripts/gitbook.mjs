#!/usr/bin/env node
// Dependency-free documentation inventory and consistency checks. No network or transactions.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, extname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const book = resolve(root, 'docs/gitbook');
// Historical source research is kept outside the published, user-facing book.
const research = resolve(root, 'docs/internal/repository-reference-2026-09-07');
const manifestPath = resolve(research, '.gitbook/assets/solidity-inventory.json');
const inventoryPage = resolve(research, 'reference/source-inventory.md');
const excluded = new Set(['node_modules', 'lib', 'out', 'cache', 'broadcast', 'artifacts',
  'build', 'generated', 'forge-out', 'pwn-reference', 'public-source-evidence']);
const roots = ['contracts/src', 'contracts/script', 'contracts/test', 'contracts/certora/harnesses', 'contracts/p2p',
  'services/wallet-profiles/test/contracts', 'output'];
const posix = p => p.split(sep).join('/');
const read = p => readFileSync(p, 'utf8');
const digest = value => createHash('sha256').update(value).digest('hex');

function walk(dir, skip = new Set()) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'en'))
    .flatMap(entry => {
      if (skip.has(entry.name) || entry.isSymbolicLink()) return [];
      const path = resolve(dir, entry.name);
      return entry.isDirectory() ? walk(path, skip) : entry.isFile() ? [path] : [];
    });
}

function family(path) {
  if (path.startsWith('contracts/p2p/')) return 'p2p';
  if (path.startsWith('output/dockyard-stress-production/contracts-review/')) return 'release-snapshot';
  if (path.startsWith('output/')) return 'artifact';
  if (path.startsWith('services/')) return 'profile-test';
  if (/contracts\/src\/(Dockyard|research\/|Oracles\/)/.test(path)) return 'credit';
  return 'liquity-or-support';
}

function collect() {
  return roots.flatMap(dir => walk(resolve(root, dir), excluded))
    .filter(path => extname(path) === '.sol')
    .map(path => {
      const source = read(path);
      const repoPath = posix(relative(root, path));
      const isSource = repoPath.startsWith('contracts/src/') || repoPath.startsWith('contracts/p2p/src/')
        || repoPath.startsWith('output/') && repoPath.includes('/src/');
      const role = isSource ? 'source' : /\/(script|scripts)\//.test(repoPath) ? 'script' : 'test-or-evidence';
      const uncommented = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
      const declarations = [...uncommented.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, '').matchAll(/\b(?:abstract\s+)?(contract|interface|library)\s+(\w+)/g)]
        .map(([, kind, name]) => ({ kind, name }));
      return { path: repoPath, sha256: digest(source), lines: source.split('\n').length - Number(source.endsWith('\n')),
        family: family(repoPath), role, declarations };
    }).sort((a, b) => a.path.localeCompare(b.path, 'en'));
}

function makePage(files) {
  const sources = files.filter(file => file.role === 'source');
  const groups = new Map();
  for (const file of sources) {
    const copies = groups.get(file.sha256) ?? [];
    copies.push(file);
    groups.set(file.sha256, copies);
  }
  const scopeLinks = {
    p2p: '../protocol/p2p/contract-reference.md',
    credit: '../protocol/credit/contract-reference.md',
    'release-snapshot': '../protocol/releases/README.md',
    artifact: '../protocol/credit/source-artifacts.md',
    'liquity-or-support': '../protocol/liquity/README.md',
  };
  const lines = [
    '---', 'description: "Content fingerprints and coverage boundaries for the Solidity in this repository."', '---', '',
    '# Solidity source inventory', '',
    'Generated from the local checkout by `node scripts/gitbook.mjs inventory`. This records file content, not deployed runtime or test results.', '',
    `The inventory contains **${files.length} Solidity files**: **${sources.length} source copies**, representing **${groups.size} distinct source contents**, plus **${files.length - sources.length} deployment/test/evidence files**. Identical source copies are grouped below; the downloadable JSON lists every included path and full SHA-256.`, '',
    '[Download the full Solidity inventory](../.gitbook/assets/solidity-inventory.json)', '',
    '## Coverage and provenance', '',
    '- Main contract implementations, interfaces, libraries and helpers under `contracts/src`, and all P2P source under `contracts/p2p/src`, are covered by the protocol chapters.',
    '- Distinct first-party source under `output` includes DirectStock/routed experiments and changed or added release-snapshot contracts. Identical copies are represented once below. A retained snapshot is not assumed identical merely because its filename matches.',
    '- Tests, fixtures and scripts are indexed for traceability. Relevant suites informed the chapters; this table is not a claim that every test was read in full or executed during documentation work.',
    '- Vendored dependencies, generated output folders, downloaded `pwn-reference` comparison code and `public-source-evidence` are excluded. Their upstream implementations are not claimed as Turret source or independently audited here.',
    '- Full SHA-256 values identify source text. Compiler settings, constructor arguments and deployment verification remain separate.', '',
    '## Contract, interface and library contents', '',
    '| Representative source path | Declarations | Lines | Copies | SHA-256 prefix | Reference |',
    '| --- | --- | ---: | ---: | --- | --- |',
  ];
  for (const [hash, copies] of groups) {
    const first = copies[0];
    const names = first.declarations.map(d => `\`${d.name}\``).join(', ') || '(no named declaration)';
    lines.push(`| \`${first.path}\` | ${names} | ${first.lines} | ${copies.length} | \`${hash.slice(0, 16)}\` | [${first.family}](${scopeLinks[first.family]}) |`);
  }
  lines.push('', '## Keeping the inventory current', '',
    'Run `node scripts/gitbook.mjs check-inventory` to detect added, removed or changed Solidity. Review the affected source and documentation before regenerating. The JSON also stores the Git HEAD observed during generation; uncommitted content is identified by per-file hashes, not attributed to that commit.', '');
  return lines.join('\n');
}

function inventory() {
  const files = collect();
  const gitHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  mkdirSync(dirname(manifestPath), { recursive: true });
  mkdirSync(dirname(inventoryPage), { recursive: true });
  writeFileSync(manifestPath, JSON.stringify({ schemaVersion: 1, gitHead, roots, excludedDirectories: [...excluded], files }, null, 2) + '\n');
  writeFileSync(inventoryPage, makePage(files));
  console.log(`Recorded ${files.length} Solidity files; source inventory regenerated. Review the diff before committing.`);
}

function check() {
  const errors = [];
  const fail = message => errors.push(message);
  const pages = walk(book).filter(path => extname(path) === '.md');
  const summaryPath = resolve(book, 'SUMMARY.md');
  if (!existsSync(summaryPath)) fail('Missing SUMMARY.md');
  const summary = existsSync(summaryPath) ? read(summaryPath) : '';
  const entries = [...summary.matchAll(/^\s*\* \[[^\]]+\]\(([^)]+)\)$/gm)].map(([, target]) => target);
  if (entries.length === 0) fail('Navigation has no pages.');
  if (new Set(entries).size !== entries.length) fail('Duplicate navigation target.');
  for (const target of entries) if (!existsSync(resolve(book, target))) fail(`Missing navigation page: ${target}`);
  const site = existsSync(resolve(root, 'gitbook-docs.yaml')) ? read(resolve(root, 'gitbook-docs.yaml')) : '';
  if (!site.includes('directory: ./docs/gitbook') || !site.includes('key: turret-documentation')) fail('Unexpected/missing GitBook site mapping.');
  const config = existsSync(resolve(book, '.gitbook.yaml')) ? read(resolve(book, '.gitbook.yaml')) : '';
  if (!/^root: \.\/$/m.test(config) || !/readme: README\.md/.test(config) || !/summary: SUMMARY\.md/.test(config)) fail('Unexpected/missing GitBook space configuration.');

  for (const path of pages) {
    const name = posix(relative(book, path));
    const source = read(path);
    if (name !== 'SUMMARY.md' && !entries.includes(name)) fail(`Page absent from navigation: ${name}`);
    if (name !== 'SUMMARY.md' && !/^---\ndescription: "[^\n]*"\n---\n/.test(source)) fail(`Missing quoted description frontmatter: ${name}`);
    if ((source.match(/^```/gm) ?? []).length % 2) fail(`Unclosed code fence: ${name}`);
    const withoutCode = source.replace(/^```[^\n]*\n[\s\S]*?^```\s*$/gm, '');
    for (const [, target] of withoutCode.matchAll(/\[[^\]]*\]\(([^\s)]+)(?:\s+"[^"]*")?\)/g)) {
      if (/^(https?:|mailto:|#)/.test(target)) continue;
      const clean = decodeURIComponent(target.split('#')[0]);
      const destination = resolve(dirname(path), clean);
      if (!destination.startsWith(book + sep)) fail(`Link leaves the GitBook space: ${name} -> ${target}`);
      else if (!existsSync(destination)) fail(`Broken local link: ${name} -> ${target}`);
    }
    for (const [, token] of withoutCode.matchAll(/`([^`\n]+)`/g)) {
      if (!/^(contracts|frontend|services|shared|cre-starter|subgraph|docs|scripts|output)\//.test(token)) continue;
      // Symbol suffixes and line numbers are citations; globs/illustrative routes aren't exact paths.
      const candidate = token.split('#')[0].replace(/:\d+$/, '');
      if (/[*{}<>|,\s]/.test(candidate) || !/\.(sol|md|mjs|mts|ts|tsx|json|toml|yaml|yml)$/.test(candidate)) continue;
      if (!existsSync(resolve(root, candidate))) fail(`Missing cited source: ${name} -> ${candidate}`);
    }
  }
  if (errors.length) {
    console.error(errors.join('\n'));
    process.exitCode = 1;
  } else console.log(`GitBook checks passed: ${pages.length - 1} pages, unique navigation, frontmatter and local links.`);
}

function checkInventory() {
  const errors = [];
  const fail = message => errors.push(message);
  if (!existsSync(manifestPath)) fail('Missing Solidity inventory; run inventory after reviewing source.');
  else {
    const stored = JSON.parse(read(manifestPath));
    const current = collect();
    const previous = new Map(stored.files.map(file => [file.path, file.sha256]));
    for (const file of current) {
      if (!previous.has(file.path)) fail(`New Solidity not inventoried: ${file.path}`);
      else if (previous.get(file.path) !== file.sha256) fail(`Solidity changed since documentation snapshot: ${file.path}`);
      previous.delete(file.path);
    }
    for (const path of previous.keys()) fail(`Inventoried Solidity removed: ${path}`);
    if (read(inventoryPage) !== makePage(stored.files)) fail('Generated source inventory page differs from its manifest.');
  }
  if (errors.length) {
    console.error(errors.join('\n'));
    process.exitCode = 1;
  } else console.log('Internal Solidity inventory fingerprints match the checkout.');
}

const command = process.argv[2] ?? 'check';
if (command === 'inventory') inventory();
else if (command === 'check') check();
else if (command === 'check-inventory') checkInventory();
else { console.error('Usage: node scripts/gitbook.mjs [check|inventory|check-inventory]'); process.exitCode = 2; }
