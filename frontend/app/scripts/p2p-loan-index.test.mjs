import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { keccak256 } from "viem";
import { createFileLoanIndexPersistence, createP2PActiveLoansHandler, createP2PLoanIndex } from "./p2p-loan-index.mjs";

const address = n => `0x${n.toString(16).padStart(40, "0")}`;
const MARKET = address(1), LENDER = address(2), BORROWER = address(3), OTHER = address(4);
const CODE = "0x60006000";
const market = { address: MARKET, chainId: 31337, version: 2, startBlock: "1", runtimeHash: keccak256(CODE) };
function fixture(options = {}) {
  let head = 90n, forkAt = null, generation = 0n;
  const events = [];
  const records = new Map();
  const reads = [], ranges = [];
  const hash = number => `0x${(number + (forkAt !== null && number >= forkAt ? generation * 100_000n : 0n)).toString(16).padStart(64, "0")}`;
  const add = (eventName, id, blockNumber, borrower = BORROWER, lender = LENDER) => {
    events.push({ eventName, args: { id: BigInt(id) }, address: MARKET, blockNumber: BigInt(blockNumber), logIndex: events.length, removed: false });
    records.set(String(id), { borrower, lender });
  };
  const client = {
    async getChainId() { return 31337; },
    async getBlock({ blockNumber = head } = {}) { return { number: blockNumber, hash: hash(blockNumber) }; },
    async getCode() { return CODE; },
    async getLogs({ fromBlock, toBlock, address: requested, events: acceptedEvents }) {
      assert.equal(requested, MARKET);
      assert.deepEqual(acceptedEvents.map(e => e.name), ["OfferAccepted", "LoanRepaid", "LoanDefaulted"]);
      ranges.push([fromBlock, toBlock]);
      return events.filter(e => e.blockNumber >= fromBlock && e.blockNumber <= toBlock && acceptedEvents.some(a => a.name === e.eventName))
        .map(e => ({ ...e, blockHash: hash(e.blockNumber) }));
    },
    async readContract({ functionName, args = [], blockNumber, address: requested }) {
      if (functionName === "nextOfferId") {
        // Counter follows creation history, including settled/cancelled offers.
        const known = events.filter(event => event.blockNumber <= blockNumber).map(event => event.args.id);
        return known.reduce((max, id) => id > max ? id : max, 0n) + 1n;
      }
      const [id] = args;
      assert.equal(functionName, "offers"); assert.equal(requested, MARKET);
      reads.push([id, blockNumber]);
      const record = records.get(id.toString());
      const last = events.filter(e => e.args.id === id && e.blockNumber <= blockNumber).sort((a, b) => Number(a.blockNumber - b.blockNumber) || a.logIndex - b.logIndex).at(-1);
      const status = { OfferAccepted: 2, LoanRepaid: 3, LoanDefaulted: 4, OfferClosed: 5 }[last?.eventName] ?? 0;
      return [record?.lender, record?.borrower, 100n, 200n, 3n, 86400n, 1000n, 900n, status];
    },
  };
  const cache = new Map();
  const index = createP2PLoanIndex({ markets: [market], client, cache, ...options });
  return { index, client, events, records, reads, ranges, cache, add, hash,
    setHead(value) { head = BigInt(value); }, reorg(at) { forkAt = BigInt(at); generation++; } };
}
const request = (index, account = BORROWER, targetBlock) => index.getActiveLoans({ market: MARKET, account, ...(targetBlock === undefined ? {} : { targetBlock }) });

test("80 cancelled targeted offers cannot hide an older active loan in V2 or legacy V1", async () => {
  for (const version of [1, 2]) {
    const f = fixture({ markets: [{ ...market, version }] });
    f.add("OfferAccepted", 1, 1);
    for (let id = 2; id <= 81; id++) f.add("OfferClosed", id, id);
    const result = await request(f.index);
    assert.equal(result.complete, true); assert.equal(result.status, "ready");
    assert.deepEqual(result.activeIds, ["1"]);
    assert.deepEqual(f.reads, [[1n, 90n]], "closed unsolicited history never consumes reads or first-page slots");
    assert.deepEqual(f.ranges, [[1n, 90n]]);
  }
});

test("bounded backfill returns incomplete data, then resumes exactly from its checkpoint", async () => {
  const f = fixture({ pageSize: 10n, maxPages: 1 }); f.setHead(30); f.add("OfferAccepted", 1, 5); f.add("OfferAccepted", 2, 25);
  const first = await request(f.index);
  assert.equal(first.complete, false); assert.equal(first.status, "syncing"); assert.equal(first.indexedThrough, "10");
  assert.equal(first.blockNumber, "30"); assert.deepEqual(first.activeIds, ["1"]);
  assert.equal((await request(f.index)).complete, false);
  const final = await request(f.index);
  assert.equal(final.complete, true); assert.deepEqual(final.activeIds, ["1", "2"]);
  assert.deepEqual(f.ranges, [[1n, 10n], [11n, 20n], [21n, 30n]]);
});

test("an empty unfinished scan is syncing, never a complete empty portfolio", async () => {
  const f = fixture({ pageSize: 10n, maxPages: 1 }); f.add("OfferAccepted", 1, 80);
  const result = await request(f.index);
  assert.deepEqual(result.activeIds, []); assert.equal(result.complete, false); assert.equal(result.status, "syncing");
});

test("repayment/default remove candidates while unclaimed overdue loans remain active", async () => {
  const f = fixture();
  for (let id = 1; id <= 3; id++) f.add("OfferAccepted", id, id);
  f.add("LoanRepaid", 1, 20); f.add("LoanDefaulted", 2, 21);
  const result = await request(f.index);
  assert.deepEqual(result.activeIds, ["3"]); assert.deepEqual(f.reads, [[3n, 90n]]);
});

test("server revalidates incomplete candidates at the requested block and filters ownership independently per wallet", async () => {
  const f = fixture({ pageSize: 10n, maxPages: 1 });
  f.add("OfferAccepted", 1, 5); f.add("LoanRepaid", 1, 20);
  f.add("OfferAccepted", 2, 6, OTHER);
  assert.deepEqual((await request(f.index)).activeIds, []);
  assert.deepEqual((await request(f.index, OTHER)).activeIds, ["2"]);
  assert.deepEqual((await request(f.index, LENDER)).activeIds, ["2"]);
  assert.ok(f.reads.every(([, block]) => block === 90n));
});

test("a reorg removes orphaned acceptances and restores loans whose repayment was orphaned", async () => {
  const f = fixture({ pageSize: 10n, maxPages: 10 }); f.setHead(40);
  f.add("OfferAccepted", 1, 5); f.add("LoanRepaid", 1, 28); f.add("OfferAccepted", 2, 35);
  assert.deepEqual((await request(f.index)).activeIds, ["2"]);
  f.events.splice(1); f.reorg(25); f.add("OfferAccepted", 3, 33);
  const result = await request(f.index);
  assert.equal(result.complete, true); assert.deepEqual(result.activeIds, ["1", "3"]);
  assert.deepEqual(f.ranges.slice(-2), [[21n, 30n], [31n, 40n]]);
});

test("deep reorg rebuilds from registered startBlock when no retained checkpoint survives", async () => {
  const f = fixture({ pageSize: 10n, maxPages: 10, retainedCheckpoints: 2 }); f.setHead(40);
  f.add("OfferAccepted", 1, 5); await request(f.index);
  f.events.length = 0; f.reorg(1); f.add("OfferAccepted", 2, 2);
  assert.deepEqual((await request(f.index)).activeIds, ["2"]);
  assert.deepEqual(f.ranges.slice(-4), [[1n, 10n], [11n, 20n], [21n, 30n], [31n, 40n]]);
});

test("RPC failure is explicit and preserves the last successful checkpoint for retry", async () => {
  const f = fixture({ pageSize: 10n, maxPages: 1 }); f.add("OfferAccepted", 1, 5);
  await request(f.index);
  const getLogs = f.client.getLogs;
  f.client.getLogs = async () => { throw new Error("upstream secret must not leak"); };
  const result = await request(f.index);
  assert.equal(result.status, "unavailable"); assert.equal(result.complete, false); assert.equal(result.blockHash, null);
  assert.equal(JSON.stringify(result).includes("secret"), false);
  assert.equal(f.cache.values().next().value.checkpoints.at(-1).blockNumber, "10");
  f.client.getLogs = getLogs;
  assert.equal((await request(f.index)).indexedThrough, "20");
});

test("persistence failure never publishes an uncommitted checkpoint as complete", async () => {
  const f = fixture({ persistence: { read: async () => undefined, write: async () => { throw new Error("disk full"); } } });
  f.add("OfferAccepted", 1, 5);
  assert.equal((await request(f.index)).status, "unavailable"); assert.equal(f.cache.size, 0);
});

test("restart resumes persisted canonical progress and atomic file persistence leaves no partial file", async t => {
  const directory = await mkdtemp(join(tmpdir(), "p2p-loan-index-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const persistence = createFileLoanIndexPersistence(directory);
  const f = fixture({ pageSize: 10n, maxPages: 1, persistence }); f.setHead(20); f.add("OfferAccepted", 1, 5);
  assert.equal((await request(f.index)).indexedThrough, "10");
  const restored = createP2PLoanIndex({ markets: [market], client: f.client, pageSize: 10n, maxPages: 1, persistence });
  const result = await request(restored);
  assert.equal(result.complete, true); assert.deepEqual(result.activeIds, ["1"]);
  assert.deepEqual(f.ranges, [[1n, 10n], [11n, 20n]]);
  assert.deepEqual(await readdir(directory), [`31337-${MARKET}.json`]);
});

test("a mismatched chain, runtime, checkpoint or event block hash never produces complete results", async () => {
  for (const kind of ["chain", "code", "checkpoint", "event"]) {
    const f = fixture(kind === "checkpoint" ? { persistence: { read: async () => ({ schemaVersion: 1, chainId: 1 }) } } : {});
    f.add("OfferAccepted", 1, 5);
    if (kind === "chain") f.client.getChainId = async () => 1;
    if (kind === "code") f.client.getCode = async () => "0x6001";
    if (kind === "event") { const getLogs = f.client.getLogs; f.client.getLogs = async args => (await getLogs(args)).map(log => ({ ...log, blockHash: `0x${"f".repeat(64)}` })); }
    assert.equal((await request(f.index)).status, "unavailable", kind);
  }
});

test("targetBlock pins reads; historical requests do not regress newer checkpoints", async () => {
  const f = fixture({ pageSize: 10n, maxPages: 10 }); f.setHead(40); f.add("OfferAccepted", 1, 5); f.add("LoanRepaid", 1, 25);
  assert.deepEqual((await request(f.index)).activeIds, []);
  const result = await request(f.index, BORROWER, "20");
  assert.equal(result.blockNumber, "20"); assert.deepEqual(result.activeIds, ["1"]);
  assert.equal(f.cache.values().next().value.checkpoints.at(-1).blockNumber, "40");
  await assert.rejects(() => request(f.index, BORROWER, "41"), /outside/);
});

test("a reorg during verification yields unavailable instead of publishing a mixed snapshot", async () => {
  const f = fixture(); f.add("OfferAccepted", 1, 5);
  const read = f.client.readContract;
  f.client.readContract = async args => { const row = await read(args); f.reorg(1); return row; };
  assert.equal((await request(f.index)).status, "unavailable");
});

test("HTTP endpoint rejects arbitrary markets, upstreams, duplicate parameters and writes", async () => {
  const f = fixture(); const handle = createP2PActiveLoansHandler(f.index);
  const call = async (url, method = "GET") => {
    const response = { writeHead(status, headers) { this.status = status; this.headers = headers; return this; }, end(body) { this.body = JSON.parse(body); } };
    await handle({ url, method }, response); return response;
  };
  const query = `/api/p2p/active-loans?market=${MARKET}&account=${BORROWER}`;
  for (const suffix of [`&rpcUrl=https://example.com`, `&market=${MARKET}`, "&targetBlock=-1"]) assert.equal((await call(query + suffix)).status, 400);
  assert.equal((await call(query.replace(MARKET, OTHER))).status, 400);
  assert.equal((await call(query, "POST")).status, 405);
  assert.equal(f.ranges.length, 0);
  const result = await call(query); assert.equal(result.status, 200); assert.equal(result.headers["Cache-Control"], "no-store");
});

test("same-market concurrent wallet requests coalesce indexing but never share account results", async () => {
  const f = fixture(); f.add("OfferAccepted", 1, 5); f.add("OfferAccepted", 2, 6, OTHER);
  const [a, b] = await Promise.all([request(f.index), request(f.index, OTHER)]);
  assert.deepEqual(a.activeIds, ["1"]); assert.deepEqual(b.activeIds, ["2"]); assert.equal(f.ranges.length, 1);
});

test("candidate and event capacity limits fail explicitly without truncating a complete response", async () => {
  for (const option of [{ maxActiveCandidates: 1 }, { maxLogsPerPage: 1 }]) {
    const f = fixture(option); f.add("OfferAccepted", 1, 5); f.add("OfferAccepted", 2, 6);
    const result = await request(f.index);
    assert.equal(result.complete, false); assert.equal(result.status, "unavailable"); assert.equal(f.cache.size, 0);
  }
});

test("HTTP concurrency stays bounded even when distinct targets queue for one market", async () => {
  let finish;
  const pending = new Promise(resolve => { finish = resolve; });
  const handle = createP2PActiveLoansHandler({ getActiveLoans: () => pending });
  const responses = [];
  const calls = Array.from({ length: 33 }, (_, i) => {
    const response = { writeHead(status) { this.status = status; return this; }, end() {} }; responses.push(response);
    return handle({ method: "GET", url: `/api/p2p/active-loans?market=${MARKET}&account=${BORROWER}&targetBlock=${i + 1}` }, response);
  });
  assert.equal(responses[32].status, 503);
  finish({ status: "ready" }); await Promise.all(calls);
  assert.ok(responses.slice(0, 32).every(response => response.status === 200));
});

test("verified nextOfferId=1 proves an empty market without backfilling deployment history", async () => {
  const f = fixture({ pageSize: 10n, maxPages: 1 }); f.setHead(400_000);
  const empty = await request(f.index);
  assert.equal(empty.complete, true); assert.equal(empty.indexedThrough, "400000"); assert.deepEqual(empty.activeIds, []);
  assert.deepEqual(f.ranges, []); assert.deepEqual(f.reads, []);
  f.setHead(400_001); f.add("OfferAccepted", 1, 400_001);
  const firstLoan = await request(f.index);
  assert.equal(firstLoan.complete, true); assert.deepEqual(firstLoan.activeIds, ["1"]);
  assert.deepEqual(f.ranges, [[400_001n, 400_001n]]);
});

test("empty-market proof detects a concurrent reorg and a persisted empty checkpoint is rewound after reorg", async () => {
  const f = fixture({ pageSize: 10n, maxPages: 10 }); f.setHead(40);
  await request(f.index);
  f.reorg(20); f.add("OfferAccepted", 1, 25);
  assert.deepEqual((await request(f.index)).activeIds, ["1"]);
  assert.deepEqual(f.ranges[0], [1n, 10n]);
  const other = fixture();
  other.client.readContract = async () => { other.reorg(1); return 1n; };
  assert.equal((await request(other.index)).status, "unavailable"); assert.equal(other.cache.size, 0);
});

test("settled history never uses the empty-market fast path even when all active liabilities are zero", async () => {
  const f = fixture({ pageSize: 10n, maxPages: 1 });
  f.add("OfferAccepted", 1, 1); f.add("LoanRepaid", 1, 2);
  const result = await request(f.index);
  assert.equal(result.complete, false); assert.equal(result.indexedThrough, "10"); assert.deepEqual(result.activeIds, []);
  assert.deepEqual(f.ranges, [[1n, 10n]]);
});
