import { keccak256, parseAbi } from "viem";

export const IMPLEMENTATION_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
export const BEACON_SLOT = "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50";
const ZERO = `0x${"0".repeat(64)}`;
const addressPattern = /^0x[0-9a-f]{40}$/i;
const hashPattern = /^0x[0-9a-f]{64}$/i;
const abi = parseAbi([
  "function loanToken() view returns (address)", "function collateralToken() view returns (address)",
  "function implementation() view returns (address)", "function vaultImplementation() view returns (address)",
  "function vaults(uint256) view returns (address)", "function manager() view returns (address)",
  "function offers(uint256) view returns (address lender,address borrower,uint256 principal,uint256 collateralAmount,uint256 interest,uint256 duration,uint256 expiresAt,uint256 dueAt,uint8 status)",
  "function paused() view returns (bool)", "function tokenPaused() view returns (bool)",
  "function isFrozen(address) view returns (bool)", "function isBlocked(address) view returns (bool)",
  "function balanceOf(address) view returns (uint256)", "function decimals() view returns (uint8)",
  "function reservedPrincipal() view returns (uint256)", "function lockedCollateral() view returns (uint256)",
  "function totalCredits(address) view returns (uint256)", "function newLoansPaused() view returns (bool)",
]);
const same = (a, b) => typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();
const cache = new WeakMap();
const read = (client, address, functionName, block, args = []) => client.readContract({ address, abi, functionName, args, blockNumber: block.number });
const slotAddress = (slot) => {
  if (!hashPattern.test(slot) || !/^0x0{24}/i.test(slot)) throw new Error("Invalid proxy slot");
  return slot === ZERO ? null : `0x${slot.slice(-40)}`;
};
async function codeHash(client, address, block) {
  const code = await client.getCode({ address, blockNumber: block.number });
  if (!code || code === "0x") throw new Error("Token code unavailable");
  return keccak256(code);
}

/** Read-only identity capture. Saving this is an operator step, never automatic requalification. */
export async function captureTokenBaseline(client, address, block, escrow) {
  const [runtimeHash, implementationSlot, beaconSlot, decimals] = await Promise.all([
    codeHash(client, address, block),
    client.getStorageAt({ address, slot: IMPLEMENTATION_SLOT, blockNumber: block.number }),
    client.getStorageAt({ address, slot: BEACON_SLOT, blockNumber: block.number }),
    read(client, address, "decimals", block),
  ]);
  const implementationAddress = slotAddress(implementationSlot);
  const beaconAddress = slotAddress(beaconSlot);
  if (implementationAddress && beaconAddress) throw new Error("Ambiguous proxy layout");
  const token = { address, runtimeHash, implementationSlot, beaconSlot, decimals, checks: [] };
  if (beaconAddress) {
    const implementation = await read(client, beaconAddress, "implementation", block);
    if (!addressPattern.test(implementation)) throw new Error("Invalid implementation");
    token.beacon = { address: beaconAddress, runtimeHash: await codeHash(client, beaconAddress, block) };
    token.implementation = { address: implementation, runtimeHash: await codeHash(client, implementation, block) };
  } else if (implementationAddress) {
    token.implementation = { address: implementationAddress, runtimeHash: await codeHash(client, implementationAddress, block) };
  }
  // Unsupported getters stay unknown. Only successfully decoded boolean methods become required checks.
  for (const name of ["paused", "tokenPaused", "isFrozen", "isBlocked"]) {
    if (!escrow && ["isFrozen", "isBlocked"].includes(name)) continue;
    try {
      const result = await read(client, address, name, block, ["isFrozen", "isBlocked"].includes(name) ? [escrow] : []);
      if (typeof result === "boolean") token.checks.push(name);
    } catch (error) {
      // viem's ESM and CJS clients have distinct error constructors.
      let cause = error, absent = false;
      for (let depth = 0; cause && depth < 8; ++depth, cause = cause.cause) {
        if (["ContractFunctionRevertedError", "ContractFunctionZeroDataError", "AbiDecodingZeroDataError"].includes(cause.name)) { absent = true; break; }
      }
      if (!absent) throw new Error("Restriction probe could not be completed");
      // A definite revert/absent ABI stays unknown; a transport outage must not
      // silently remove a required check from a new baseline.
    }
  }
  return token;
}

export function validateTokenBaseline(value, chainId) {
  if (!value || value.schemaVersion !== 1 || value.chainId !== chainId || !Array.isArray(value.tokens)
    || value.tokens.length > 250 || !/^\d+$/.test(value.blockNumber) || !hashPattern.test(value.blockHash)) throw new Error("Token baseline is unavailable");
  const seen = new Set();
  for (const token of value.tokens) {
    if (!addressPattern.test(token.address) || seen.has(token.address.toLowerCase()) || !hashPattern.test(token.runtimeHash)
      || !hashPattern.test(token.implementationSlot) || !hashPattern.test(token.beaconSlot)
      || !Number.isInteger(token.decimals) || token.decimals < 0 || token.decimals > 36
      || !Array.isArray(token.checks) || new Set(token.checks).size !== token.checks.length
      || token.checks.some(name => !["paused", "tokenPaused", "isFrozen", "isBlocked"].includes(name))) throw new Error("Token baseline is invalid");
    seen.add(token.address.toLowerCase());
    const implementation = slotAddress(token.implementationSlot), beacon = slotAddress(token.beaconSlot);
    if (implementation && beacon || Boolean(token.beacon) !== Boolean(beacon)
      || Boolean(token.implementation) !== Boolean(implementation || beacon)) throw new Error("Token baseline proxy binding is invalid");
    if (beacon && !same(token.beacon.address, beacon) || implementation && !same(token.implementation.address, implementation)) throw new Error("Token baseline proxy binding is invalid");
    for (const component of [token.beacon, token.implementation].filter(Boolean)) {
      if (!addressPattern.test(component.address) || !hashPattern.test(component.runtimeHash)) throw new Error("Token baseline component is invalid");
    }
  }
  return value;
}

export { inspectToken as inspectTokenBaseline };
async function inspectToken(client, expected, block) {
  // Shared across markets at this exact canonical block. Failed reads are never cached as healthy.
  let entries = cache.get(client);
  if (!entries) { entries = new Map(); cache.set(client, entries); }
  const key = `${block.hash}:${expected.address.toLowerCase()}:${JSON.stringify(expected)}`;
  if (!entries.has(key)) {
    if (entries.size > 128) entries.clear();
    const promise = (async () => {
      const [hash, implementationSlot, beaconSlot, decimals] = await Promise.all([
        codeHash(client, expected.address, block),
        client.getStorageAt({ address: expected.address, slot: IMPLEMENTATION_SLOT, blockNumber: block.number }),
        client.getStorageAt({ address: expected.address, slot: BEACON_SLOT, blockNumber: block.number }),
        read(client, expected.address, "decimals", block),
      ]);
      if (!hashPattern.test(implementationSlot) || !hashPattern.test(beaconSlot)) throw new Error("Token storage check unavailable");
      if (!same(hash, expected.runtimeHash) || !same(implementationSlot, expected.implementationSlot)
        || !same(beaconSlot, expected.beaconSlot) || decimals !== expected.decimals) return "Token code or configuration changed. New loans await review.";
      if (expected.beacon) {
        if (!same(await codeHash(client, expected.beacon.address, block), expected.beacon.runtimeHash)
          || !same(await read(client, expected.beacon.address, "implementation", block), expected.implementation.address)) return "The collateral implementation changed. New loans await review.";
      }
      if (expected.implementation && !same(await codeHash(client, expected.implementation.address, block), expected.implementation.runtimeHash)) return "A token implementation changed. New loans await review.";
      for (const name of expected.checks.filter(name => !["isFrozen", "isBlocked"].includes(name))) {
        const result = await read(client, expected.address, name, block);
        if (typeof result !== "boolean") throw new Error("Token restriction check unavailable");
        if (result) return "A token is paused. New loans are unavailable.";
      }
      return null;
    })();
    entries.set(key, promise);
    promise.catch(() => entries.delete(key));
  }
  return entries.get(key);
}

/** Controls new exposure only. A failed health check must never disable repayment or withdrawals. */
export async function inspectP2PHealth(client, market, baseline, block, now = Date.now(), offerId) {
  const started = Date.now();
  const observation = { blockNumber: String(block.number), blockHash: block.hash, checkedAt: now };
  try {
    validateTokenBaseline(baseline, market.chainId);
    if (!hashPattern.test(block.hash) || typeof block.timestamp !== "bigint" || Math.abs(now / 1000 - Number(block.timestamp)) > 180) throw new Error("Chain state is stale");
    const tokens = [market.loanToken, market.collateralToken].map(address => baseline.tokens.find(token => same(token.address, address)));
    if (tokens.some(token => !token)) throw new Error("Token qualification is missing");
    if (tokens[0].decimals !== market.loanDecimals || tokens[1].decimals !== market.collateralDecimals) throw new Error("Token decimals differ");
    const reasons = [];
    const [escrowHash, loanBinding, collateralBinding] = await Promise.all([
      codeHash(client, market.address, block), read(client, market.address, "loanToken", block), read(client, market.address, "collateralToken", block),
    ]);
    if (!same(escrowHash, market.runtimeHash) || !same(loanBinding, market.loanToken) || !same(collateralBinding, market.collateralToken)) throw new Error("Escrow identity changed");
    for (const token of tokens) {
      const reason = await inspectToken(client, token, block);
      if (reason) reasons.push(reason);
      for (const name of token.checks.filter(name => ["isFrozen", "isBlocked"].includes(name))) {
        const restricted = await read(client, token.address, name, block, [market.address]);
        if (typeof restricted !== "boolean") throw new Error("Escrow restriction check unavailable");
        if (restricted) reasons.push("Token transfers for this escrow are restricted. New loans are unavailable.");
      }
    }
    if (market.version === 3) {
      // V3 manager counters are nominal accounting only. Custody belongs to each
      // loan's immutable clone; comparing the manager's zero balance to counters
      // would incorrectly disable every funded V3 market.
      if (!addressPattern.test(market.vaultImplementation) || !hashPattern.test(market.vaultImplementationHash)) throw new Error("Missing V3 vault identity");
      const [implementation, implementationHash, managerBinding, loanBinding, collateralBinding] = await Promise.all([
        read(client, market.address, "vaultImplementation", block), codeHash(client, market.vaultImplementation, block),
        read(client, market.vaultImplementation, "manager", block), read(client, market.vaultImplementation, "loanToken", block),
        read(client, market.vaultImplementation, "collateralToken", block),
      ]);
      if (!same(implementation, market.vaultImplementation) || !same(implementationHash, market.vaultImplementationHash)
        || !same(managerBinding, market.address) || !same(loanBinding, market.loanToken) || !same(collateralBinding, market.collateralToken)) throw new Error("V3 vault identity changed");
      if (offerId !== undefined) {
        if (typeof offerId !== "bigint" || offerId <= 0n) throw new Error("Invalid offer identity");
        const [vault, offer] = await Promise.all([
          read(client, market.address, "vaults", block, [offerId]), read(client, market.address, "offers", block, [offerId]),
        ]);
        if (!addressPattern.test(vault) || /^0x0{40}$/i.test(vault) || !Array.isArray(offer) || offer.length !== 9
          || typeof offer[2] !== "bigint" || offer[2] <= 0n) throw new Error("Invalid offer vault");
        const cloneCode = await client.getCode({ address: vault, blockNumber: block.number });
        const expectedCode = `0x363d3d373d3d3d363d73${market.vaultImplementation.slice(2)}5af43d82803e903d91602b57fd5bf3`;
        if (!same(cloneCode, expectedCode)) throw new Error("Offer vault is not the verified immutable clone");
        const [vaultManager, vaultLoan, vaultCollateral, balance] = await Promise.all([
          read(client, vault, "manager", block), read(client, vault, "loanToken", block), read(client, vault, "collateralToken", block),
          read(client, market.loanToken, "balanceOf", block, [vault]),
        ]);
        if (!same(vaultManager, market.address) || !same(vaultLoan, market.loanToken) || !same(vaultCollateral, market.collateralToken)
          || typeof balance !== "bigint" || balance < 0n) throw new Error("Invalid offer vault custody");
        if (offer[8] !== 1 || offer[6] <= block.timestamp) reasons.push("This offer is no longer available. Refresh the marketplace.");
        if (balance < offer[2]) reasons.push("This offer's vault has a token shortfall. It cannot fund the promised loan.");
        for (const token of tokens) {
          for (const name of token.checks.filter(name => ["isFrozen", "isBlocked"].includes(name))) {
            const restricted = await read(client, token.address, name, block, [vault]);
            if (typeof restricted !== "boolean") throw new Error("Vault restriction check unavailable");
            if (restricted) reasons.push("Token transfers for this loan vault are restricted. The offer cannot be accepted.");
          }
        }
      }
    } else {
      const [cash, collateral, reserved, locked, cashCredits, collateralCredits] = await Promise.all([
        read(client, market.loanToken, "balanceOf", block, [market.address]), read(client, market.collateralToken, "balanceOf", block, [market.address]),
        read(client, market.address, "reservedPrincipal", block), read(client, market.address, "lockedCollateral", block),
        read(client, market.address, "totalCredits", block, [market.loanToken]), read(client, market.address, "totalCredits", block, [market.collateralToken]),
      ]);
      if ([cash, collateral, reserved, locked, cashCredits, collateralCredits].some(value => typeof value !== "bigint" || value < 0n)) throw new Error("Invalid escrow balances");
      if (cash < reserved + cashCredits || collateral < locked + collateralCredits) reasons.push("This escrow has a token shortfall. New loans are unavailable while it is reviewed.");
    }
    const paused = await read(client, market.address, "newLoansPaused", block);
    if (typeof paused !== "boolean") throw new Error("Invalid pause state");
    if (paused) reasons.push("New loans are paused for this market.");
    if (!same((await client.getBlock({ blockNumber: block.number })).hash, block.hash)) throw new Error("Chain state changed");
    if (Math.abs((now + Date.now() - started) / 1000 - Number(block.timestamp)) > 180) throw new Error("Chain state became stale during verification");
    return { ...observation, status: reasons.length ? "blocked" : "ok", reasons: [...new Set(reasons)] };
  } catch {
    return { ...observation, status: "unavailable", reasons: ["Current token and escrow checks could not be verified. Refresh before creating or accepting a loan."] };
  }
}
