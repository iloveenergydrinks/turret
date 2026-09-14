#!/usr/bin/env node
// Build a small, reproducible upload directory for the standalone documentation service.
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const target = resolve(root, 'output/turret-docs/release');
rmSync(target, { recursive: true, force: true });
mkdirSync(resolve(target, 'scripts'), { recursive: true });
mkdirSync(resolve(target, 'docs'), { recursive: true });
for (const filename of ['package.json', 'package-lock.json', 'Dockerfile', 'railway.toml', '.dockerignore', '.gitignore']) {
  cpSync(resolve(root, 'deploy/docs', filename), resolve(target, filename));
}
cpSync(resolve(root, 'scripts/serve-gitbook.mjs'), resolve(target, 'scripts/serve-gitbook.mjs'));
cpSync(resolve(root, 'docs/gitbook'), resolve(target, 'docs/gitbook'), { recursive: true });
console.log(`Documentation release prepared: ${target}`);
console.log('Deploy this directory as its own Railway service. No main application or secrets are included.');
