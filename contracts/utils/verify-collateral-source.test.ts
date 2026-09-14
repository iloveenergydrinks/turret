import assert from "node:assert/strict";
import { test } from "node:test";
import { sourceSummary } from "./verify-collateral-source";
const token = "0x0000000000000000000000000000000000000001" as const;
const fixture = { chainId: "4663", address: token, runtimeMatch: "match", creationMatch: null,
  runtimeBytecode: { onchainBytecode: "0x6000" }, sources: { "Token.yul": { content: 'object "Token" {}' } } };

test("matching runtime record includes source hashes but never approves behavior", () => {
  const summary = sourceSummary(fixture, token, "0x6000");
  assert.equal(summary.runtimeBytes, 2);
  assert.match(summary.sources[0].keccak256, /^0x[0-9a-f]{64}$/);
  assert.equal(summary.providerCreationMatch, null);
  assert.equal(summary.independentCompilationPerformed, false);
  assert.equal(summary.behaviorReviewComplete, false);
  assert.equal(summary.admission, "not-approved");
});
test("wrong chain, token, missing code or changed runtime cannot pass", () => {
  assert.throws(() => sourceSummary({...fixture, chainId: 1}, token, "0x6000"), /identity/);
  assert.throws(() => sourceSummary({...fixture, address: "0x0000000000000000000000000000000000000002"}, token, "0x6000"), /identity/);
  assert.throws(() => sourceSummary(fixture, token, "0x"), /bytecode/);
  assert.throws(() => sourceSummary(fixture, token, "0x6001"), /bytecode/);
});
test("absent provider match or source cannot pass", () => {
  assert.throws(() => sourceSummary({...fixture, runtimeMatch: null}, token, "0x6000"), /runtime match/);
  assert.throws(() => sourceSummary({...fixture, sources: {}}, token, "0x6000"), /No sources/);
  assert.throws(() => sourceSummary({...fixture, sources: {"Token.sol": {content:""}}}, token, "0x6000"), /source content/);
});
