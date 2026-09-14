import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionData,
  keccak256,
  parseAbi,
  parseAbiParameters,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { negotiationMessage } from "../src/p2p/negotiations-shared.mjs";
import { createP2PNegotiations, negotiationTerms } from "./p2p-negotiations.mjs";
const borrower = privateKeyToAccount(`0x${"11".repeat(32)}`),
  lender = privateKeyToAccount(`0x${"22".repeat(32)}`),
  other = privateKeyToAccount(`0x${"33".repeat(32)}`);
const origin = "http://localhost:3000",
  market = {
    address: `0x${"44".repeat(20)}`,
    loanToken: `0x${"55".repeat(20)}`,
    collateralToken: `0x${"66".repeat(20)}`,
    chainId: 31337,
    version: 3,
    runtimeHash: keccak256("0x6000"),
  };
const hash = `0x${"77".repeat(32)}`, zero = `0x${"00".repeat(20)}`;
const abi = parseAbi([
  "function cancelOffer(uint256)",
  "function createOffer(address,uint256,uint256,uint256,uint256,uint256)",
  "event OfferCreated(uint256 indexed id,address indexed lender,address indexed borrower,uint256 principal,uint256 collateralAmount,uint256 interest,uint256 duration,uint256 expiresAt)",
]);
let nonce = 0;
function fixture(filename) {
  let time = 2000000000;
  const terms = {
    principal: "100000000",
    collateral: "2000000000000000000",
    interest: "1000000",
    durationDays: 7,
    expiresAt: time + 86400,
  };
  const offer = [
    lender.address,
    zero,
    BigInt(terms.principal),
    BigInt(terms.collateral),
    BigInt(terms.interest),
    604800n,
    BigInt(terms.expiresAt),
    0n,
    1,
  ];
  const state = {
    offer,
    balance: 100000000n,
    credit: 100000000n,
    block: 10n,
    reorg: false,
    code: "0x6000",
    chain: 31337,
    tx: null,
    receipt: null,
    replacement: null,
    cancellationTx: null,
    cancellationReceipt: null,
  };
  const client = {
    getChainId: async () => state.chain,
    getBlock: async (args) => ({
      number: args?.blockNumber ?? state.block,
      hash: args && state.reorg ? `0x${"88".repeat(32)}` : hash,
      timestamp: BigInt(time),
    }),
    getCode: async () => state.code,
    readContract: async ({ functionName, args }) =>
      ({
        loanToken: market.loanToken,
        collateralToken: market.collateralToken,
        offers: args?.[0] === 2n ? state.replacement : state.offer,
        vaults: `0x${"99".repeat(20)}`,
        balanceOf: state.balance,
        loanCredit: [lender.address, state.credit, state.credit],
      })[functionName],
    getTransaction: async ({ hash: h }) => h === hash && state.cancellationTx ? state.cancellationTx : state.tx,
    getTransactionReceipt: async ({ hash: h }) =>
      h === hash && state.cancellationReceipt ? state.cancellationReceipt : state.receipt,
  };
  const options = { markets: [market], client, origin, filename, now: () => time };
  const service = createP2PNegotiations(options);
  const signed = async (account, action, overrides = {}) => {
    const envelope = {
      version: 1,
      origin,
      market: market.address,
      chainId: 31337,
      account: account.address,
      issuedAt: time,
      validUntil: time + 300,
      nonce: `0x${(++nonce).toString(16).padStart(64, "0")}`,
      ...action,
      ...overrides,
    };
    return { envelope, signature: await account.signMessage({ message: negotiationMessage(envelope) }) };
  };
  const submit = async (account, action) => service.submit(await signed(account, action));
  const login = async (account) => (await submit(account, { action: "login" })).token;
  const ref = (row) => ({
    threadId: row.id,
    revision: row.revision,
    proposalId: row.latest.id,
    context: {
      sourceDigest: row.sourceDigest,
      lender: row.lender,
      borrower: row.borrower,
      proposalTerms: row.latest.terms,
    },
  });
  const setup = async (account = borrower) => {
    const token = await login(account), s = (await service.inspect(market.address, 31337, "1", token)).source;
    const row =
      (await submit(account, { action: "open", offerId: "1", sourceDigest: s.digest, terms, responseBy: time + 3600 }))
        .thread;
    return { row, token };
  };
  return { service, state, terms, setup, login, submit, signed, ref, options, advance: (n) => time += n };
}
test("private reads, exact signatures, idempotency and persisted history", async () => {
  const dir = await mkdtemp(join(tmpdir(), "turret-neg-"));
  const f = fixture(join(dir, "state.sqlite"));
  try {
    const { row, token } = await f.setup();
    assert.equal(f.service.list(token).threads.length, 1);
    assert.throws(() => f.service.list("", { id: row.id }), /Unlock/);
    const stranger = await f.login(other);
    assert.equal(f.service.list(stranger).threads.length, 0);
    assert.throws(() => f.service.list(stranger, { id: row.id }), /unavailable/);
    const action = await f.signed(lender, {
      action: "counter",
      ...f.ref(row),
      terms: { ...f.terms, interest: "2000000" },
      responseBy: 2000001800,
    });
    const accepted = await f.service.submit(action);
    assert.deepEqual(await f.service.submit(action), accepted);
    const forged = { ...action, envelope: { ...action.envelope, terms: { ...f.terms, principal: "1" } } };
    await assert.rejects(f.service.submit(forged), /signature/);
    await assert.rejects(f.submit(borrower, { action: "agree", ...f.ref(row) }), /changed/);
    f.service.close();
    const restored = createP2PNegotiations(f.options);
    assert.equal(restored.list(token, { id: row.id }).events.length, 2);
    restored.close();
  } finally {
    try {
      f.service.close();
    } catch {}
    await rm(dir, { recursive: true, force: true });
  }
});
test("bilateral counters, no self agreement, source-level selection and close", async () => {
  const f = fixture();
  try {
    let { row } = await f.setup();
    await assert.rejects(f.submit(borrower, { action: "agree", ...f.ref(row) }), /other participant/);
    row = (await f.submit(lender, {
      action: "counter",
      ...f.ref(row),
      terms: { ...f.terms, interest: "0" },
      responseBy: 2000001800,
    })).thread;
    row =
      (await f.submit(borrower, { action: "counter", ...f.ref(row), terms: f.terms, responseBy: 2000001800 })).thread;
    row = (await f.submit(lender, { action: "agree", ...f.ref(row) })).thread;
    const second = (await f.setup(other)).row;
    await assert.rejects(f.submit(lender, { action: "agree", ...f.ref(second) }), /already been selected/);
    await f.submit(borrower, { action: "close", ...f.ref(row) });
    assert.equal((await f.submit(lender, { action: "agree", ...f.ref(second) })).thread.state, "agreed");
  } finally {
    f.service.close();
  }
});
test("source eligibility, shortfall, expiry, reorg and exact numeric bounds", async () => {
  const f = fixture();
  try {
    const token = await f.login(borrower);
    f.state.reorg = true;
    await assert.rejects(f.service.inspect(market.address, 31337, "1", token), /Chain changed/);
    f.state.reorg = false;
    f.state.code = "0x6001";
    await assert.rejects(f.service.inspect(market.address, 31337, "1", token), /identity/);
    f.state.code = "0x6000";
    f.state.offer[1] = other.address;
    await assert.rejects(f.service.inspect(market.address, 31337, "1", token), /unavailable/);
    f.state.offer[1] = zero;
    f.state.balance = 0n;
    await assert.rejects(f.setup(), /funded/);
    f.state.balance = 100000000n;
    const { row } = await f.setup();
    f.advance(3601);
    await assert.rejects(f.submit(lender, { action: "agree", ...f.ref(row) }), /expired/);
    for (
      const terms of [{ ...f.terms, principal: "0" }, { ...f.terms, collateral: "1.5" }, {
        ...f.terms,
        interest: (1n << 256n).toString(),
      }, { ...f.terms, durationDays: 1.5 }]
    ) assert.throws(() => negotiationTerms(terms, 2000000000));
  } finally {
    f.service.close();
  }
});
test("replacement requires planned cancellation, full recovery and matching creation receipt", async () => {
  const f = fixture();
  try {
    let { row } = await f.setup();
    row = (await f.submit(lender, { action: "agree", ...f.ref(row) })).thread;
    row = (await f.submit(lender, { action: "start", ...f.ref(row) })).thread;
    await assert.rejects(f.submit(borrower, { action: "close", ...f.ref(row) }), /recovery/);
    f.state.offer[8] = 5;
    f.state.block = 11n;
    f.state.tx = {
      from: lender.address,
      to: market.address,
      value: 0n,
      input: encodeFunctionData({ abi, functionName: "cancelOffer", args: [1n] }),
    };
    f.state.receipt = {
      from: lender.address,
      status: "success",
      transactionHash: hash,
      blockNumber: 11n,
      blockHash: hash,
    };
    row = (await f.submit(lender, { action: "cancelled", ...f.ref(row), hash })).thread;
    await assert.rejects(f.submit(lender, { action: "prepare", ...f.ref(row) }), /Withdraw/);
    f.state.credit = 0n;
    row = (await f.submit(lender, { action: "prepare", ...f.ref(row) })).thread;
    const token = await f.login(lender);
    await f.service.preflight(token, row.id, row.attempt);
    await assert.rejects(f.submit(lender, { action: "prepare", ...f.ref(row) }), /Withdraw/);
    f.state.cancellationTx = { ...f.state.tx };
    f.state.cancellationReceipt = { ...f.state.receipt };
    const fundingHash = `0x${"ab".repeat(32)}`;
    f.state.block = 12n;
    f.state.tx.input = encodeFunctionData({
      abi,
      functionName: "createOffer",
      args: [borrower.address, 100000000n, 2000000000000000000n, 1000000n, 604800n, BigInt(f.terms.expiresAt)],
    });
    f.state.receipt = {
      ...f.state.receipt,
      transactionHash: fundingHash,
      blockNumber: 12n,
      logs: [{
        address: market.address,
        topics: encodeEventTopics({
          abi,
          eventName: "OfferCreated",
          args: { id: 2n, lender: lender.address, borrower: borrower.address },
        }),
        data: encodeAbiParameters(parseAbiParameters("uint256,uint256,uint256,uint256,uint256"), [
          100000000n,
          2000000000000000000n,
          1000000n,
          604800n,
          BigInt(f.terms.expiresAt),
        ]),
      }],
    };
    f.state.replacement = [...f.state.offer];
    f.state.replacement[1] = borrower.address;
    f.state.replacement[8] = 1;
    row = (await f.submit(lender, { action: "bind", ...f.ref(row), hash: fundingHash })).thread;
    assert.equal(row.replacement.id, "2");
    assert.equal(row.state, "funded");
  } finally {
    f.service.close();
  }
});

test("HTTP participant access, private cache policy and cross-origin mutation rejection", async () => {
  const { createServer } = await import("node:http");
  const { createNegotiationsHandler } = await import("./p2p-negotiations.mjs");
  const f = fixture();
  const handler = createNegotiationsHandler(f.service);
  const server = createServer((request, response) => {
    void handler(request, response);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}/api/p2p/negotiations`;
  try {
    const { row, token } = await f.setup();
    const denied = await fetch(url + "?id=" + row.id);
    assert.equal(denied.status, 401);
    assert.match(denied.headers.get("cache-control"), /private, no-store/);
    const own = await fetch(url + "?id=" + row.id, { headers: { Authorization: "Bearer " + token } });
    assert.equal(own.status, 200);
    assert.equal((await own.json()).thread.id, row.id);
    const stranger = await f.login(other);
    const hidden = await fetch(url + "?id=" + row.id, { headers: { Authorization: "Bearer " + stranger } });
    assert.equal(hidden.status, 404);
    assert(!JSON.stringify(await hidden.json()).includes(row.borrower));
    const signed = await f.signed(lender, { action: "agree", ...f.ref(row) });
    const cross = await fetch(url, {
      method: "POST",
      headers: { Origin: "https://other.example", "Content-Type": "application/json" },
      body: JSON.stringify(signed),
    });
    assert.equal(cross.status, 403);
    const accepted = await fetch(url, {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify(signed),
    });
    assert.equal(accepted.status, 200);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    f.service.close();
  }
});

test("agreement binds displayed parties and exact proposal terms; errors and races never free a selected source", async () => {
  const f = fixture();
  try {
    const { row } = await f.setup();
    await assert.rejects(
      f.submit(lender, {
        action: "agree",
        ...f.ref(row),
        context: { ...f.ref(row).context, proposalTerms: { ...row.latest.terms, interest: "0" } },
      }),
      /changed/,
    );
    const [a, b] = await Promise.allSettled([
      f.submit(lender, { action: "agree", ...f.ref(row) }),
      f.submit(borrower, { action: "counter", ...f.ref(row), terms: f.terms, responseBy: 2000001800 }),
    ]);
    assert.equal([a, b].filter((x) => x.status === "fulfilled").length, 1);
    const signed = await f.signed(borrower, { action: "login" });
    f.advance(301);
    await assert.rejects(f.service.submit(signed), /expired/);
  } finally {
    f.service.close();
  }
});
