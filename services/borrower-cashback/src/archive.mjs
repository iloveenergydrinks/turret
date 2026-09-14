import { mkdirSync, openSync, writeFileSync, fsyncSync, closeSync, readFileSync, readdirSync, statSync, linkSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { verifyAllocationClaim } from './merkle.mjs';

const hash = value => typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value);
function validate(value) {
  if (!hash(value.root) || !hash(value.blockHash) || !Number.isSafeInteger(value.throughBlock) || value.throughBlock < 0
    || !Number.isSafeInteger(value.chainId) || value.chainId <= 0 || !Array.isArray(value.claims) || !value.claims.length
    || value.claims.length > 1024) throw new Error('Invalid allocation archive');
  const seen = new Set();
  for (const claim of value.claims) {
    const key = `${claim.borrower.toLowerCase()}:${claim.engine.toLowerCase()}`;
    if (seen.has(key) || BigInt(claim.cumulative) <= 0n || !Array.isArray(claim.proof) || claim.proof.length > 64
      || !claim.proof.every(hash) || !verifyAllocationClaim(value, claim)) throw new Error('Invalid archived claim');
    seen.add(key);
  }
  return value;
}
export function saveAllocation(directory, allocation) {
  validate(allocation);
  mkdirSync(directory, { recursive:true, mode:0o700 });
  const path = join(directory, `${allocation.root}.json`);
  const body = JSON.stringify(allocation, (_,v) => typeof v === 'bigint' ? v.toString() : v, 2) + '\n';
  const temporary = join(directory,`${allocation.root}.${randomUUID()}.tmp`);
  const descriptor = openSync(temporary,'wx',0o600);
  try {
    try { writeFileSync(descriptor,body); fsyncSync(descriptor); } finally { closeSync(descriptor); }
    linkSync(temporary,path); // Atomic publication; never overwrite an existing allocation.
  } finally { unlinkSync(temporary); }
  const folder = openSync(directory,'r');
  try { fsyncSync(folder); } finally { closeSync(folder); }
  return path;
}
export function readAllocations(directory) {
  mkdirSync(directory, { recursive:true, mode:0o700 });
  return readdirSync(directory).filter(name => /^0x[0-9a-fA-F]{64}\.json$/.test(name)).map(name => {
    const path = join(directory,name);
    if (statSync(path).size > 16 * 1024 * 1024) throw new Error('Allocation archive is too large');
    const value = validate(JSON.parse(readFileSync(path,'utf8')));
    if (`${value.root}.json` !== name) throw new Error('Allocation filename mismatch');
    return value;
  });
}
