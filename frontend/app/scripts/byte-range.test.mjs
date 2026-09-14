import assert from "node:assert/strict";
import { test } from "node:test";
import { parseByteRange } from "./byte-range.mjs";

test("no range keeps the full response", () => {
  assert.equal(parseByteRange(undefined, 100), null);
});

test("supports browser probe, bounded, open-ended and suffix ranges", () => {
  assert.deepEqual(parseByteRange("bytes=0-1", 100), { start: 0, end: 1 });
  assert.deepEqual(parseByteRange("bytes=10-49", 100), { start: 10, end: 49 });
  assert.deepEqual(parseByteRange("bytes=50-", 100), { start: 50, end: 99 });
  assert.deepEqual(parseByteRange("bytes=-20", 100), { start: 80, end: 99 });
});

test("clamps ranges to the file size", () => {
  assert.deepEqual(parseByteRange("bytes=0-200", 100), { start: 0, end: 99 });
  assert.deepEqual(parseByteRange("bytes=-200", 100), { start: 0, end: 99 });
});

test("rejects unsatisfiable or unsupported ranges", () => {
  for (const range of ["bytes=100-", "bytes=10-5", "bytes=-0", "bytes=-", "bytes=0-1,4-5", "cats=0-1", "bytes=9007199254740992-"]) {
    assert.equal(parseByteRange(range, 100), false, range);
  }
  assert.equal(parseByteRange("bytes=0-1", 0), false);
});
