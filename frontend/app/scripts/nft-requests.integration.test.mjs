import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createPublicClient, createWalletClient, defineChain, http, keccak256 } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { createNFTRequests, createNFTRequestPersistence } from "./nft-requests.mjs";
import { nftRequestActionMessage } from "../src/nft/requests-shared.mjs";

// Always starts its own chain 31337. No external RPC, token balances or private keys are accepted.
test("real local transactions: readable request → direct deposit → automatic chain discovery → acceptance, repayment, cancellation, expiry and default", { timeout: 60_000 }, async () => {
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
    const token = await artifact("LocalToken"), manager = await artifact("TurretNFTLending"), nft = JSON.parse(await readFile(new URL("../../../contracts/p2p/out/TurretNFTLending.t.sol/TestNFT.json", import.meta.url), "utf8"));
    let transactions = 0;
    const receipt = async hash => { const result = await client.waitForTransactionReceipt({ hash }); assert.equal(result.status, "success"); transactions++; return result; };
    const deploy = async (art, args) => (await receipt(await wallet(guardian).deployContract({ abi: art.abi, bytecode: art.bytecode.object, args }))).contractAddress;
    const loanToken = await deploy(token, ["Request test USDG", "USDG", 6]);
    const collateralToken = await deploy(nft, []);
    const address = await deploy(manager, [loanToken, guardian.address]);
    const write = async (account, target, abi, functionName, args) => receipt(await wallet(account).writeContract({ address: target, abi, functionName, args }));
    await write(guardian, loanToken, token.abi, "mint", [lender.address, 100_000000n]);
    await write(guardian, collateralToken, nft.abi, "mint", [borrower.address, 0n]);
    await write(guardian, address, manager.abi, "setCollectionAllowed", [collateralToken, true]);
    await write(guardian, address, manager.abi, "setNewLoansPaused", [false]);
    const block = await client.getBlock(); const now = Number(block.timestamp);
    const market = { address, chainId: 31337, version: 1, loanToken, collections: [collateralToken], runtimeHash: keccak256(await client.getCode({ address })) };
    const origin = "http://localhost:3000", persistence = createNFTRequestPersistence(directory);
    const service = createNFTRequests({ markets: [market], client, persistence, origin, now: () => now });
    let nonce = 1;
    const submit = async (account, action) => {
      const envelope = { version: 2, origin, chainId: 31337, market: address, account: account.address, issuedAt: now, validUntil: now + 300,
        nonce: `0x${(nonce++).toString(16).padStart(64, "0")}`, ...action };
      return (await service.submit({ envelope, signature: await account.signMessage({ message: nftRequestActionMessage(envelope) }) })).request;
    };
    const requested = { principal: "25000000", collection: collateralToken, tokenId: "0", interest: "500000", durationDays: 30, expiresAt: now + 7 * 86400 };
    let row = await submit(borrower, { action: "publish", terms: requested });
    const proposed = { ...requested, interest: "1000000", durationDays: 14 };
    assert.equal(await client.readContract({ address, abi: manager.abi, functionName: "nextOfferId" }), 1n, "listing alone cannot open a loan");
    await write(lender, loanToken, token.abi, "approve", [address, 25_000000n]);
    await write(lender, address, manager.abi, "createOffer", [{ borrower: borrower.address, collection: collateralToken, tokenId: 0n, principal: 25_000000n, interest: 1_000000n, duration: 14n * 86400n, expiresAt: BigInt(proposed.expiresAt) }]);
    row = (await service.list({requestId:row.id})).requests[0];
    assert.equal(row.liveOffers[0].id,"1"); assert.equal(row.liveOffers[0].status,"open");
    assert.equal(row.proposals.length,0,"direct deposit needs no proposal, agreement or signed linking");
    const restarted = createNFTRequests({ markets: [market], client, persistence, origin, now: () => now });
    assert.equal((await restarted.list({ requestId: row.id })).requests[0].liveOffers[0].id, "1");
    await write(borrower, collateralToken, nft.abi, "approve", [address, 0n]);
    await write(borrower, address, manager.abi, "acceptOffer", [1n]);
    row = (await service.list({requestId:row.id})).requests[0];
    assert.equal(row.liveOffers[0].status, "active");
    const offer = await client.readContract({ address, abi: manager.abi, functionName: "getOffer", args: [1n] });
    assert.equal(offer.status, 2); assert.equal(offer.terms.interest, 1_000000n); assert.equal(offer.terms.duration, 14n * 86400n);
    assert.equal(await client.readContract({ address: loanToken, abi: token.abi, functionName: "balanceOf", args: [borrower.address] }), 25_000000n);
    assert.equal(transactions, 11);
    assert.equal(await client.readContract({ address: collateralToken, abi: nft.abi, functionName: "ownerOf", args: [0n] }), offer.vault);
    // Repayment is independent of request-board state and provider-recipient acceptance.
    await write(guardian, loanToken, token.abi, "mint", [borrower.address, 1_000000n]);
    await write(borrower, loanToken, token.abi, "approve", [address, 26_000000n]);
    await write(borrower, address, manager.abi, "repay", [1n]);
    assert.equal((await service.list({requestId:row.id})).requests[0].liveOffers[0].status,"repaid");
    await write(borrower, address, manager.abi, "withdrawNFT", [1n, borrower.address]);
    await write(lender, address, manager.abi, "withdrawUSDG", [1n, 26_000000n, lender.address]);
    assert.equal(await client.readContract({ address: collateralToken, abi: nft.abi, functionName: "ownerOf", args: [0n] }), borrower.address);
    assert.equal(await client.readContract({ address: loanToken, abi: token.abi, functionName: "balanceOf", args: [lender.address] }), 101_000000n);
    assert.equal(transactions, 16);
    const deposit = async (id, expiresAt) => {
      await write(lender,loanToken,token.abi,"approve",[address,25_000000n]);
      await write(lender,address,manager.abi,"createOffer",[{borrower:borrower.address,collection:collateralToken,tokenId:0n,principal:25_000000n,interest:1_000000n,duration:86400n,expiresAt}]);
      assert.equal((await service.list({requestId:row.id})).requests[0].liveOffers[0].id,String(id));
    };
    await deposit(2,BigInt(now+86400));
    await write(lender,address,manager.abi,"cancelOffer",[2n]);
    assert.equal((await service.list({requestId:row.id})).requests[0].liveOffers[0].status,"cancelled");
    await write(lender,address,manager.abi,"withdrawUSDG",[2n,25_000000n,lender.address]);
    await deposit(3,(await client.getBlock()).timestamp+5n);
    await client.request({method:"evm_increaseTime",params:[6]});await client.request({method:"evm_mine"});
    assert.equal((await service.list({requestId:row.id})).requests[0].liveOffers[0].status,"expired");
    await write(lender,address,manager.abi,"expireOffer",[3n]);
    await write(lender,address,manager.abi,"withdrawUSDG",[3n,25_000000n,lender.address]);
    await deposit(4,(await client.getBlock()).timestamp+86400n);
    await write(borrower,collateralToken,nft.abi,"approve",[address,0n]);
    await write(borrower,address,manager.abi,"acceptOffer",[4n]);
    await client.request({method:"evm_increaseTime",params:[172801]});await client.request({method:"evm_mine"});
    await write(lender,address,manager.abi,"settleDefault",[4n]);
    assert.equal((await service.list({requestId:row.id})).requests[0].liveOffers[0].status,"defaulted");
    await write(lender,address,manager.abi,"withdrawNFT",[4n,lender.address]);
    assert.equal(await client.readContract({address:collateralToken,abi:nft.abi,functionName:"ownerOf",args:[0n]}),lender.address);
    assert.equal(nonce,2,"only the optional borrower listing required a message signature");
  } finally { process.kill("SIGTERM"); await rm(directory, { recursive: true, force: true }); }
});
