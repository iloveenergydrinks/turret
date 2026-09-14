import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createPublicClient, createWalletClient, defineChain, http, keccak256 } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { negotiationMessage } from "../src/p2p/negotiations-shared.mjs";
import { createP2PNegotiations } from "./p2p-negotiations.mjs";

// Always starts its own chain 31337. No external RPC, token balances or private keys are accepted.
test("real V3 transactions: negotiate → cancel → recover USDG → replace → accept → repay → withdraw", {
  timeout: 60_000,
}, async () => {
  const reservation = createServer();
  await new Promise((resolve) => reservation.listen(0, "127.0.0.1", resolve));
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  const process = spawn(`${homedir()}/.foundry/bin/anvil`, [
    "--host",
    "127.0.0.1",
    "--port",
    String(port),
    "--chain-id",
    "31337",
    "--silent",
  ], { stdio: "ignore" });
  let startupError;
  process.on("error", (error) => {
    startupError = error;
  });
  const url = `http://127.0.0.1:${port}`;
  const chain = defineChain({
    id: 31337,
    name: "P2P request integration",
    nativeCurrency: { name: "Test ETH", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [url] } },
  });
  const client = createPublicClient({ chain, transport: http(url, { retryCount: 0 }), pollingInterval: 10 });
  const mnemonic = "test test test test test test test test test test test junk";
  const [guardian, lender, borrower] = [0, 1, 2].map((addressIndex) => mnemonicToAccount(mnemonic, { addressIndex }));
  const wallet = (account) => createWalletClient({ account, chain, transport: http(url), pollingInterval: 10 });
  const directory = await mkdtemp(join(tmpdir(), "p2p-requests-integration-"));
  let service;
  try {
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      if (startupError) throw startupError;
      try {
        ready = await client.getChainId() === 31337;
      } catch {}
      if (ready) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert(ready);
    assert.match(await client.request({ method: "web3_clientVersion" }), /anvil/i);
    const artifact = async (name) =>
      JSON.parse(
        await readFile(new URL(`../../../contracts/p2p/out/${name}.sol/${name}.json`, import.meta.url), "utf8"),
      );
    const token = await artifact("LocalToken"), manager = await artifact("TurretP2PLendingV3");
    let transactions = 0;
    const receipt = async (hash) => {
      const result = await client.waitForTransactionReceipt({ hash });
      assert.equal(result.status, "success");
      transactions++;
      return result;
    };
    const deploy = async (art, args) =>
      (await receipt(await wallet(guardian).deployContract({ abi: art.abi, bytecode: art.bytecode.object, args })))
        .contractAddress;
    const loanToken = await deploy(token, ["Request test USDG", "USDG", 6]);
    const collateralToken = await deploy(token, ["Request test collateral", "COLL", 18]);
    const address = await deploy(manager, [loanToken, collateralToken, guardian.address]);
    const write = async (account, target, abi, functionName, args) =>
      receipt(await wallet(account).writeContract({ address: target, abi, functionName, args }));
    await write(guardian, loanToken, token.abi, "mint", [lender.address, 100_000000n]);
    await write(guardian, collateralToken, token.abi, "mint", [borrower.address, 10n * 10n ** 18n]);
    const block = await client.getBlock();
    const now = Number(block.timestamp);
    const market = {
      address,
      chainId: 31337,
      version: 3,
      loanToken,
      collateralToken,
      runtimeHash: keccak256(await client.getCode({ address })),
    };
    const origin = "http://localhost:3000";
    service = createP2PNegotiations({
      markets: [market],
      client,
      filename: join(directory, "negotiations.sqlite"),
      origin,
      now: () => now,
    });
    let nonce = 1;
    const submit = async (account, action) => {
      const envelope = {
        version: 1,
        origin,
        chainId: 31337,
        market: address,
        account: account.address,
        issuedAt: now,
        validUntil: now + 300,
        nonce: `0x${(nonce++).toString(16).padStart(64, "0")}`,
        ...action,
      };
      return service.submit({
        envelope,
        signature: await account.signMessage({ message: negotiationMessage(envelope) }),
      });
    };
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
    const terms = {
      principal: "25000000",
      collateral: "2000000000000000000",
      interest: "1000000",
      durationDays: 14,
      expiresAt: now + 7 * 86400,
    };
    await write(lender, loanToken, token.abi, "approve", [address, 25_000000n]);
    await write(lender, address, manager.abi, "createOffer", [
      "0x0000000000000000000000000000000000000000",
      25_000000n,
      2n * 10n ** 18n,
      2_000000n,
      30n * 86400n,
      BigInt(terms.expiresAt),
    ]);
    const session = await submit(borrower, { action: "login" });
    const source = (await service.inspect(address, 31337, "1", session.token)).source;
    let row = (await submit(borrower, {
      action: "open",
      offerId: "1",
      sourceDigest: source.digest,
      terms,
      responseBy: now + 3600,
    })).thread;
    row = (await submit(lender, {
      action: "counter",
      ...ref(row),
      terms: { ...terms, interest: "1500000" },
      responseBy: now + 3600,
    })).thread;
    row = (await submit(borrower, { action: "counter", ...ref(row), terms, responseBy: now + 3600 })).thread;
    row = (await submit(lender, { action: "agree", ...ref(row) })).thread;
    assert.equal(await client.readContract({ address, abi: manager.abi, functionName: "nextOfferId" }), 2n);
    row = (await submit(lender, { action: "start", ...ref(row) })).thread;
    const cancelled = await write(lender, address, manager.abi, "cancelOffer", [1n]);
    row = (await submit(lender, { action: "cancelled", ...ref(row), hash: cancelled.transactionHash })).thread;
    await assert.rejects(submit(lender, { action: "prepare", ...ref(row) }), /Withdraw/);
    await write(lender, address, manager.abi, "withdrawCredit", [1n, loanToken, 25_000000n, lender.address]);
    row = (await submit(lender, { action: "prepare", ...ref(row) })).thread;
    const lenderSession = await submit(lender, { action: "login" });
    await service.preflight(lenderSession.token, row.id, row.attempt);
    await write(lender, loanToken, token.abi, "approve", [address, 25_000000n]);
    const funded = await write(lender, address, manager.abi, "createOffer", [
      borrower.address,
      25_000000n,
      2n * 10n ** 18n,
      1_000000n,
      14n * 86400n,
      BigInt(terms.expiresAt),
    ]);
    row = (await submit(lender, { action: "bind", ...ref(row), hash: funded.transactionHash })).thread;
    assert.equal(row.replacement.id, "2");
    service.close();
    service = createP2PNegotiations({
      markets: [market],
      client,
      filename: join(directory, "negotiations.sqlite"),
      origin,
      now: () => now,
    });
    assert.equal(service.list(session.token, { id: row.id }).thread.replacement.id, "2");
    await write(borrower, collateralToken, token.abi, "approve", [address, 2n * 10n ** 18n]);
    await write(borrower, address, manager.abi, "acceptOffer", [2n]);
    assert.equal(
      await client.readContract({
        address: loanToken,
        abi: token.abi,
        functionName: "balanceOf",
        args: [borrower.address],
      }),
      25_000000n,
    );
    await write(guardian, loanToken, token.abi, "mint", [borrower.address, 1_000000n]);
    await write(borrower, loanToken, token.abi, "approve", [address, 26_000000n]);
    await write(borrower, address, manager.abi, "repay", [2n]);
    await write(borrower, address, manager.abi, "withdrawCredit", [
      2n,
      collateralToken,
      2n * 10n ** 18n,
      borrower.address,
    ]);
    await write(lender, address, manager.abi, "withdrawCredit", [2n, loanToken, 26_000000n, lender.address]);
    assert.equal(
      await client.readContract({
        address: loanToken,
        abi: token.abi,
        functionName: "balanceOf",
        args: [lender.address],
      }),
      101_000000n,
    );
    assert.equal(
      await client.readContract({
        address: collateralToken,
        abi: token.abi,
        functionName: "balanceOf",
        args: [borrower.address],
      }),
      10n * 10n ** 18n,
    );
    assert.equal((await client.readContract({ address, abi: manager.abi, functionName: "offers", args: [2n] }))[8], 3);
  } finally {
    service?.close();
    process.kill("SIGTERM");
    await rm(directory, { recursive: true, force: true });
  }
});
