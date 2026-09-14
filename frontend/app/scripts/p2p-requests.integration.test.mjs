import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createPublicClient, createWalletClient, defineChain, http, keccak256 } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { createP2PRequests, createFileRequestPersistence } from "./p2p-requests.mjs";
import { requestActionMessage } from "../src/p2p/requests-shared.mjs";

// Always starts its own chain 31337. No external RPC, token balances or private keys are accepted.
test("real local transactions: signed request → counteroffer → agreement → exact funded offer → borrower acceptance", { timeout: 60_000 }, async () => {
  const reservation = createServer(); await new Promise(resolve => reservation.listen(0, "127.0.0.1", resolve));
  const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
  const process = spawn(`${homedir()}/.foundry/bin/anvil`, ["--host", "127.0.0.1", "--port", String(port), "--chain-id", "31337", "--silent"], { stdio: "ignore" });
  let startupError; process.on("error", error => { startupError = error; });
  const url = `http://127.0.0.1:${port}`;
  const chain = defineChain({ id: 31337, name: "P2P request integration", nativeCurrency: { name: "Test ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [url] } } });
  const client = createPublicClient({ chain, transport: http(url, { retryCount: 0 }), pollingInterval: 10 });
  const mnemonic = "test test test test test test test test test test test junk";
  const [guardian, lender, borrower] = [0, 1, 2].map(addressIndex => mnemonicToAccount(mnemonic, { addressIndex }));
  const wallet = account => createWalletClient({ account, chain, transport: http(url), pollingInterval: 10 });
  const directory = await mkdtemp(join(tmpdir(), "p2p-requests-integration-"));
  try {
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      if (startupError) throw startupError;
      try { ready = await client.getChainId() === 31337; } catch {}
      if (ready) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert(ready); assert.match(await client.request({ method: "web3_clientVersion" }), /anvil/i);
    const artifact = async name => JSON.parse(await readFile(new URL(`../../../contracts/p2p/out/${name}.sol/${name}.json`, import.meta.url), "utf8"));
    const token = await artifact("LocalToken"), manager = await artifact("TurretP2PLendingV3");
    let transactions = 0;
    const receipt = async hash => { const result = await client.waitForTransactionReceipt({ hash }); assert.equal(result.status, "success"); transactions++; return result; };
    const deploy = async (art, args) => (await receipt(await wallet(guardian).deployContract({ abi: art.abi, bytecode: art.bytecode.object, args }))).contractAddress;
    const loanToken = await deploy(token, ["Request test USDG", "USDG", 6]);
    const collateralToken = await deploy(token, ["Request test collateral", "COLL", 18]);
    const address = await deploy(manager, [loanToken, collateralToken, guardian.address]);
    const write = async (account, target, abi, functionName, args) => receipt(await wallet(account).writeContract({ address: target, abi, functionName, args }));
    await write(guardian, loanToken, token.abi, "mint", [lender.address, 100_000000n]);
    await write(guardian, collateralToken, token.abi, "mint", [borrower.address, 10n * 10n ** 18n]);
    const block = await client.getBlock(); const now = Number(block.timestamp);
    const market = { address, chainId: 31337, version: 3, loanToken, collateralToken, runtimeHash: keccak256(await client.getCode({ address })) };
    const origin = "http://localhost:3000", persistence = createFileRequestPersistence(directory);
    const service = createP2PRequests({ markets: [market], client, persistence, origin, now: () => now });
    let nonce = 1;
    const submit = async (account, action) => {
      const envelope = { version: 1, origin, chainId: 31337, market: address, account: account.address, issuedAt: now, validUntil: now + 300,
        nonce: `0x${(nonce++).toString(16).padStart(64, "0")}`, ...action };
      return (await service.submit({ envelope, signature: await account.signMessage({ message: requestActionMessage(envelope) }) })).request;
    };
    const requested = { principal: "25000000", collateral: "2000000000000000000", interest: "500000", durationDays: 30, expiresAt: now + 7 * 86400 };
    let row = await submit(borrower, { action: "publish", terms: requested });
    const proposed = { ...requested, interest: "1000000", durationDays: 14 };
    row = await submit(lender, { action: "propose", requestId: row.id, revision: row.revision, terms: proposed });
    const proposalId = row.proposals[0].id;
    row = await submit(borrower, { action: "accept", requestId: row.id, revision: row.revision, proposalId });
    assert.equal(row.status, "agreed");
    assert.equal(await client.readContract({ address, abi: manager.abi, functionName: "nextOfferId" }), 1n, "offchain negotiation cannot open a loan");
    await write(lender, loanToken, token.abi, "approve", [address, 25_000000n]);
    await write(lender, address, manager.abi, "createOffer", [borrower.address, 25_000000n, 2n * 10n ** 18n, 1_000000n, 14n * 86400n, BigInt(proposed.expiresAt)]);
    row = await submit(lender, { action: "bind", requestId: row.id, revision: row.revision, proposalId, offerId: "1" });
    assert.equal(row.proposals[0].fundedOffer.status, "open");
    const restarted = createP2PRequests({ markets: [market], client, persistence, origin, now: () => now });
    assert.equal((await restarted.list({ requestId: row.id })).requests[0].proposals[0].fundedOffer.id, "1");
    await write(borrower, collateralToken, token.abi, "approve", [address, 2n * 10n ** 18n]);
    await write(borrower, address, manager.abi, "acceptOffer", [1n]);
    row = await submit(borrower, { action: "bind", requestId: row.id, revision: row.revision, proposalId, offerId: "1" });
    assert.equal(row.proposals[0].fundedOffer.status, "active");
    const offer = await client.readContract({ address, abi: manager.abi, functionName: "offers", args: [1n] });
    assert.equal(offer[8], 2); assert.equal(offer[4], 1_000000n); assert.equal(offer[5], 14n * 86400n);
    assert.equal(await client.readContract({ address: loanToken, abi: token.abi, functionName: "balanceOf", args: [borrower.address] }), 25_000000n);
    assert.equal(transactions, 9);
  } finally { process.kill("SIGTERM"); await rm(directory, { recursive: true, force: true }); }
});
