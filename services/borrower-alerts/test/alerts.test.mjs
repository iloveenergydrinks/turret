import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { verifyMessage } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { positionHealth } from "../../../shared/position-health.mjs";
import { Engine, hash } from "../src/engine.mjs";
import { Monitor, VAULT } from "../src/monitor.mjs";
import { Store } from "../src/store.mjs";
const wallet = "0x1111111111111111111111111111111111111111";
const market = "0x2222222222222222222222222222222222222222";
const WAD = 10n ** 18n;
const health = (debt, price = 100n * WAD) => positionHealth({ collateral: WAD, debt, price, liquidationLtvBps: 5000n });
function fixture(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), "dockyard-alert-tests-"));
  const path = join(directory, "alerts.sqlite");
  const store = new Store(path, "ab".repeat(32));
  let now = 1800000000000;
  const sent = [];
  const engine = new Engine({
    store,
    origin: "https://turret.capital",
    vault: VAULT,
    now: () => now,
    verify: async () => true,
    send: async (...args) => {
      sent.push(args);
    },
    ...options,
  });
  t.after(() => {
    store.close();
    rmSync(directory, { recursive: true });
  });
  return {
    engine,
    store,
    sent,
    path,
    advance: (ms) => {
      now += ms;
    },
  };
}
function activate(e, channel = "email") {
  const code = e.subscribe(wallet, channel, "test@example.com");
  e.activate(code, channel, channel === "telegram" ? "123" : undefined);
}

test("borrowers receive only actionable liquidation risk, never operational or recovery mail", async t => {
  const {engine:e,sent,store,advance}=fixture(t);activate(e);await e.deliver();sent.length=0;
  for(const status of ['unknown','healthy','no-debt','unknown']){e.risk(wallet,market,{status});advance(1);await e.deliver();}
  e.notify(wallet,'ops:failure','Dockyard: your submitted transaction failed on-chain.');
  // Old queued messages must also be suppressed when the new release starts.
  store.put('outbox','legacy-outage',{subId:`${wallet}:email`,text:'Risk data unavailable',next:0,until:e.now()+10000,attempts:0});
  await e.deliver();assert.equal(sent.length,0);
  e.risk(wallet,market,health(45_000000n));await e.deliver();assert.equal(sent.length,1);
  e.risk(wallet,market,{status:'unknown'});advance(1);e.risk(wallet,market,health(45_000000n));await e.deliver();assert.equal(sent.length,1);
  advance(1);e.risk(wallet,market,health(49_000000n));await e.deliver();assert.equal(sent.length,2);
  e.risk(wallet,market,health(44_000000n));await e.deliver();assert.equal(sent.length,2);
});
test('an undelivered warning cancelled by an outage is requeued when risk can be verified again',async t=>{
 const {engine:e,sent,advance}=fixture(t);activate(e);
 e.risk(wallet,market,health(49_000000n));
 e.risk(wallet,market,{status:'unknown'});await e.deliver();assert.equal(sent.length,0);
 advance(1);e.risk(wallet,market,health(49_000000n));await e.deliver();assert.equal(sent.length,1);
});
test('a repaid position starts a fresh warning episode if a new loan becomes at risk',async t=>{
 const {engine:e,sent,advance}=fixture(t);activate(e);
 e.risk(wallet,market,health(49_000000n));await e.deliver();assert.equal(sent.length,1);
 e.risk(wallet,market,{status:'no-debt'});advance(1);e.risk(wallet,market,health(49_000000n));await e.deliver();assert.equal(sent.length,2);
});

test("risk thresholds use exact vault floors; equality is safe but critical", () => {
  assert.equal(health(44_000000n).status, "healthy");
  assert.equal(health(45_000000n).status, "warning");
  assert.equal(health(48_500000n).status, "critical");
  assert.equal(health(50_000000n).status, "critical");
  assert.equal(health(50_000001n).status, "eligible");
  assert.equal(health(50_000000n, null).status, "unknown");
  assert.equal(health(0n, null).status, "no-debt");
});
test("estimated boundary agrees with integer safety over small and large balances", () => {
  for (let i = 1n; i < 500n; i++) {
    const collateral = i * 9007199254740993n, debt = i * 13177n;
    const args = { collateral, debt, price: WAD, liquidationLtvBps: 5714n };
    const boundary = positionHealth(args).liquidationPrice;
    assert.notEqual(positionHealth({ ...args, price: boundary }).status, "eligible");
    assert.equal(positionHealth({ ...args, price: boundary - 1n }).status, "eligible");
  }
});
test("wallet signature verifies cryptographically, nonce replay and wrong signer fail", async (t) => {
  const { engine: e } = fixture(t, {
    verify: (address, message, signature) => verifyMessage({ address, message, signature }),
  });
  // Public, disposable test vector. Never a deployed or funded signer.
  const account = privateKeyToAccount("0x" + "01".repeat(32));
  const challenge = e.challenge(account.address);
  const signature = await account.signMessage({ message: challenge.message });
  const session = await e.login(challenge.id, signature);
  assert.equal(e.authenticate(session.session), account.address.toLowerCase());
  await assert.rejects(e.login(challenge.id, signature), /already used/);
  const wrong = e.challenge(wallet);
  await assert.rejects(e.login(wrong.id, await account.signMessage({ message: wrong.message })), /does not match/);
});
test("expired signatures and sessions are rejected", async (t) => {
  const { engine: e, advance } = fixture(t);
  const first = e.challenge(wallet);
  advance(300001);
  await assert.rejects(e.login(first.id, "x"), /expired/);
  const next = e.challenge(wallet), session = await e.login(next.id, "x");
  advance(1800001);
  assert.throws(() => e.authenticate(session.session), /again/);
});
test("unverified email receives only confirmation; verification is one-time and channel-bound", async (t) => {
  const { engine: e, sent } = fixture(t);
  const code = e.subscribe(wallet, "email", "test@example.com");
  e.risk(wallet, market, health(49_000000n));
  await e.deliver();
  assert.equal(sent.length, 1);
  assert.match(sent[0][2], /Confirm Turret/);
  assert.throws(() => e.activate(code, "telegram", "123"), /expired/);
  e.activate(code, "email");
  assert.throws(() => e.activate(code, "email"), /expired/);
  assert.equal(e.list(wallet).length, 1);
});
test("Telegram requires a private numeric chat; revocation removes contact and queued jobs", async (t) => {
  const { engine: e, store, sent } = fixture(t);
  const code = e.subscribe(wallet, "telegram");
  assert.throws(() => e.activate(code, "telegram", "-123"), /Private/);
  e.activate(code, "telegram", "123");
  e.remove(wallet, "telegram");
  await e.deliver();
  assert.equal(sent.length, 0);
  assert.equal(store.all("subscription").length, 0);
  assert.equal(store.all("outbox").length, 0);
});
test("warnings escalate, reminders are throttled, and recovery cancels stale queued warnings silently", async (t) => {
  const { engine: e, sent, advance } = fixture(t);
  activate(e);
  await e.deliver();
  sent.length = 0;
  e.risk(wallet, market, health(44_000000n));
  await e.deliver();
  assert.equal(sent.length, 0);
  e.risk(wallet, market, health(45_000000n));
  await e.deliver();
  assert.equal(sent.length, 1);
  e.risk(wallet, market, health(45_000000n));
  await e.deliver();
  assert.equal(sent.length, 1);
  advance(3600001);
  e.risk(wallet, market, health(45_000000n));
  await e.deliver();
  assert.equal(sent.length, 2);
  advance(1);
  e.risk(wallet, market, health(49_000000n));
  advance(1);
  e.risk(wallet, market, health(44_000000n));
  await e.deliver();
  assert.equal(sent.length, 2);
});
test("provider failure persists retries and provider acceptance clears failed status", async (t) => {
  let fail = true;
  const { engine: e, store, advance } = fixture(t, {
    send: async () => {
      if (fail) throw new Error("provider down");
    },
  });
  activate(e);
  e.risk(wallet,market,health(49_000000n));
  await e.deliver();
  assert.equal(e.list(wallet)[0].failed, true);
  const first = store.all("outbox")[0];
  assert.equal(first.attempts, 1);
  await e.deliver();
  assert.equal(store.all("outbox")[0].attempts, 1);
  fail = false;
  advance(30001);
  await e.deliver();
  assert.equal(store.all("outbox").length, 0);
  assert.equal(e.list(wallet)[0].failed, false);
});
test("contacts are encrypted on disk and records survive reopening", (t) => {
  const { engine: e, store, path } = fixture(t);
  activate(e);
  store.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  assert.equal(readFileSync(path).includes(Buffer.from("test@example.com")), false);
  const second = new Store(path, "ab".repeat(32));
  assert.equal(second.all("subscription")[0].contact, "test@example.com");
  second.close();
});
test("pending link expiration, wallet quotas and malformed contacts are enforced", (t) => {
  const { engine: e, advance } = fixture(t);
  assert.throws(() => e.subscribe(wallet, "email", "injected\r\n@example.com"), /valid/);
  const code = e.subscribe(wallet, "email", "test@example.com");
  advance(900001);
  assert.throws(() => e.activate(code, "email"), /expired/);
  for (let i = 0; i < 10; i++) e.challenge(wallet);
  assert.throws(() => e.challenge(wallet), /Too many/);
});
function fakeClient(e) {
  return {
    getChainId: async () => 4663,
    getBlock: async ({ blockNumber = 100n } = {}) => ({
      number: blockNumber,
      hash: `block-${blockNumber}`,
      timestamp: BigInt(Math.floor(e.now() / 1000)),
    }),
    getCode: async () => "0x1234",
    readContract: async ({ functionName }) =>
      ({
        collateralCount: 1n,
        collateralAt: market,
        markets: [0, 0, 0, 4500, 5000],
        price: 100n * WAD,
        positions: [WAD, 49_000000n],
      })[functionName],
    getContractEvents: async () => [],
    getTransaction: async () => ({ from: wallet, to: VAULT }),
    getTransactionReceipt: async () => ({ blockNumber: 80n, status: "reverted" }),
  };
}
test("monitor uses one block for price and position; missing oracle emits unknown not healthy", async (t) => {
  const { engine: e, store } = fixture(t);
  activate(e);
  const client = fakeClient(e), original = client.readContract, blocks = [];
  client.readContract = async (args) => {
    blocks.push(args.blockNumber);
    if (args.functionName === "price") throw new Error();
    return original(args);
  };
  const monitor = new Monitor(e, client);
  await monitor.scan();
  assert.equal(store.get("risk", `${wallet}:${market}`).status, "unknown");
  assert.equal(monitor.healthyAt, 0);
  assert.ok(blocks.every((n) => n === 100n));
});
test("monitor rejects wrong chain and stale head; never invents a healthy position", async (t) => {
  const { engine: e, store } = fixture(t);
  activate(e);
  const client = fakeClient(e);
  client.getChainId = async () => 1;
  await assert.rejects(new Monitor(e, client).scan(), /scan failed/);
  assert.equal(store.get("risk", `${wallet}:monitor`).status, "unknown");
  client.getChainId = async () => 4663;
  client.getBlock = async () => ({ number: 100n, timestamp: 1n });
  await assert.rejects(new Monitor(e, client).scan(), /scan failed/);
});
test("confirmed liquidation is recorded without email and event cursor refuses reorg", async (t) => {
  const { engine: e, store, sent, advance } = fixture(t);
  activate(e);
  await e.deliver();
  const client = fakeClient(e), monitor = new Monitor(e, client);
  await monitor.scan();
  advance(2000);
  sent.length = 0;
  client.getBlock = async ({ blockNumber = 102n } = {}) => ({
    number: blockNumber,
    hash: `block-${blockNumber}`,
    timestamp: BigInt(Math.floor(e.now() / 1000)),
  });
  client.getContractEvents = async () => [{
    transactionHash: "0xabc",
    logIndex: 1,
    blockNumber: 89n,
    args: { borrower: wallet, collateral: market, repaid: 50_000000n },
  }];
  await monitor.scan();
  await e.deliver();
  assert.equal(sent.filter((s) => s[2].includes("liquidation confirmed")).length, 0);
  assert.ok(store.get('event','0xabc:1'));
  await monitor.scan();
  await e.deliver();
  assert.equal(sent.filter((s) => s[2].includes("liquidation confirmed")).length, 0);
  store.put("cursor", "liquidations", { block: "90", hash: "reorg" });
  await assert.rejects(monitor.scan());
  assert.equal(monitor.healthyAt, 0);
});
test("failed transactions are verified and recorded without borrower emails", async (t) => {
  const { engine: e, sent, store } = fixture(t);
  activate(e);
  await e.deliver();
  sent.length = 0;
  const client = fakeClient(e), monitor = new Monitor(e, client), tx = "0x" + "34".repeat(32);
  client.getTransaction = async () => ({ from: market, to: VAULT });
  await assert.rejects(monitor.watch(wallet, tx));
  client.getTransaction = async () => ({ from: wallet, to: market });
  await assert.rejects(monitor.watch(wallet, tx));
  client.getTransaction = async () => ({ from: wallet, to: VAULT });
  await monitor.watch(wallet, tx);
  await monitor.transactions(79n);
  await e.deliver();
  assert.equal(sent.length, 0);
  await monitor.transactions(80n);
  await e.deliver();
  assert.equal(sent.length, 0);
  assert.ok(store.get('event',`failed:${tx}`));
});
