import { encodeAbiParameters, parseAbiParameters, keccak256, concatHex, getAddress } from 'viem';

export function allocationLeaf(chainId, distributor, borrower, engine, cumulative) {
  return keccak256(keccak256(encodeAbiParameters(
    parseAbiParameters('uint256,address,address,address,uint256'),
    [BigInt(chainId), getAddress(distributor), getAddress(borrower), getAddress(engine), BigInt(cumulative)]
  )));
}
const parent = (a, b) => keccak256(concatHex(a < b ? [a, b] : [b, a]));

export function verifyAllocationClaim({ chainId, distributor, root }, claim) {
  let hash = allocationLeaf(chainId, distributor, claim.borrower, claim.engine, claim.cumulative);
  for (const sibling of claim.proof) hash = parent(hash, sibling);
  return hash === root;
}

/** Sorted-pair Merkle tree matching the distributor's OpenZeppelin verification. */
export function buildAllocation({ chainId, distributor, accounts }) {
  const seen = new Set();
  const claims = accounts.filter(a => a.confirmedRebate > 0n).map(account => {
    const borrower = getAddress(account.borrower), engine = getAddress(account.engine);
    const id = `${borrower}:${engine}`;
    if (seen.has(id)) throw new Error('Duplicate reward account');
    seen.add(id);
    if (account.confirmedRebate > account.cap) throw new Error('Allocation exceeds enrollment cap');
    const cumulative = account.confirmedRebate;
    return { borrower, engine, cumulative, leaf: allocationLeaf(chainId, distributor, borrower, engine, cumulative), proof: [] };
  }).sort((a, b) => a.leaf.localeCompare(b.leaf));
  if (!claims.length) throw new Error('No confirmed rewards to publish');
  const levels = [claims.map(claim => claim.leaf)];
  while (levels.at(-1).length > 1) {
    const current = levels.at(-1), next = [];
    for (let i = 0; i < current.length; i += 2) next.push(current[i + 1] ? parent(current[i], current[i + 1]) : current[i]);
    levels.push(next);
  }
  for (let i = 0; i < claims.length; i++) {
    let index = i;
    for (const level of levels.slice(0, -1)) {
      const sibling = index % 2 === 0 ? index + 1 : index - 1;
      if (sibling < level.length) claims[i].proof.push(level[sibling]);
      index = Math.floor(index / 2);
    }
  }
  return { root: levels.at(-1)[0], chainId, distributor: getAddress(distributor), claims };
}
