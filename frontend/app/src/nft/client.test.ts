// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { decodeFunctionData, encodeFunctionData, encodeEventTopics, encodeAbiParameters, erc20Abi, keccak256, type Address, type EIP1193Provider, type Hex } from "viem";
import { nftLendingAbi } from "./abi";
import { NFTClient, validateNFTConfig, type NFTConfig } from "./client";
import { savePending } from "../p2p/pending-transactions";

const mocks = vi.hoisted(() => ({ rpc: {} as Record<"getChainId" | "getCode" | "getBlock" | "readContract" | "call" | "getTransaction" | "getTransactionReceipt" | "waitForTransactionReceipt" | "getTransactionCount", ReturnType<typeof vi.fn>> }));
vi.mock("viem", async original => ({ ...await original<typeof import("viem")>(), createPublicClient: () => mocks.rpc }));
const address = (byte: string) => `0x${byte.repeat(40)}` as Address;
const hash = (byte: string) => `0x${byte.repeat(64)}` as Hex;
const account = address("1"), market = address("2"), token = address("3"), collection = address("4");
const code = "0x60006000" as Hex, data = "0x12345678" as Hex, txHash = hash("a"), blockHash = hash("b");
const config: NFTConfig = { version: 1, chainId: 4663, address: market, loanToken: token, loanDecimals: 6,
  runtimeHash: keccak256(code), startBlock: "1", rpcUrl: "/api/rpc", collections: [{ address: collection, name: "Cats", slug: "cats", image: "", enabled: true }] };
let client: NFTClient;
let provider: EIP1193Provider;
let walletRequest: ReturnType<typeof vi.fn>;
let transaction: Record<string, unknown>;
let receipt: Record<string, unknown>;
beforeEach(() => {
  const held = new Set<string>();
  Object.defineProperty(navigator, "locks", { configurable: true, value: { request: async (key: string, _options: unknown, action: (lock: unknown) => unknown) => {
    if (held.has(key)) return action(null);
    held.add(key); try { return await action({ name: key }); } finally { held.delete(key); }
  } } });
  window.localStorage.clear(); window.sessionStorage.clear();
  transaction = { hash: txHash, from: account, to: market, input: data, value: 0n, nonce: 7, blockNumber: 10n };
  receipt = { transactionHash: txHash, from: account, to: market, blockHash, blockNumber: 10n, status: "success", logs: [] };
  mocks.rpc = {
    getChainId: vi.fn().mockResolvedValue(4663), getCode: vi.fn().mockResolvedValue(code),
    getBlock: vi.fn().mockImplementation(async () => ({ number: 10n, hash: blockHash, timestamp: 1_800_000_000n, transactions: [txHash] })),
    readContract: vi.fn().mockImplementation(async ({ functionName }) => functionName === "loanToken" ? token : functionName === "decimals" ? 6 : 0n),
    call: vi.fn().mockResolvedValue({ data: "0x" }), getTransaction: vi.fn().mockImplementation(async () => transaction),
    getTransactionReceipt: vi.fn().mockImplementation(async () => receipt),
    waitForTransactionReceipt: vi.fn().mockImplementation(async () => receipt),
    getTransactionCount: vi.fn().mockResolvedValue(7),
  };
  walletRequest = vi.fn().mockImplementation(async ({ method }) => method === "eth_accounts" ? [account] : method === "eth_chainId" ? "0x1237" : txHash);
  provider = { request: walletRequest, on: vi.fn(), removeListener: vi.fn() } as unknown as EIP1193Provider;
  client = new NFTClient(config, "http://127.0.0.1:1");
});
const send = () => client.send(provider, account, market, data, () => {});
describe("NFT wallet transaction verification", () => {
  it("verifies call, canonical receipt and saved intent before clearing a successful transaction", async () => {
    await expect(send()).resolves.toMatchObject({ status: "success" });
    expect(mocks.rpc.call).toHaveBeenCalledWith({ account, to: market, data, value: 0n });
    expect(client.pending(account)).toBeNull();
  });
  it("blocks wrong RPC chain, runtime and loan token before invoking wallet submission", async () => {
    for (const failure of ["chain", "runtime", "token"]) {
      mocks.rpc.getChainId.mockResolvedValue(failure === "chain" ? 1 : 4663);
      mocks.rpc.getCode.mockResolvedValue(failure === "runtime" ? "0x6001" : code);
      mocks.rpc.readContract.mockImplementation(async ({ functionName }) => functionName === "loanToken" ? failure === "token" ? collection : token : 6);
      await expect(send()).rejects.toThrow();
    }
    expect(provider.request).not.toHaveBeenCalled();
  });
  it("checks the wallet again after simulation and rejects an account switch", async () => {
    mocks.rpc.call.mockImplementation(async () => { walletRequest.mockImplementation(async ({ method }) => method === "eth_accounts" ? [collection] : "0x1237" as never); return { data: "0x" }; });
    await expect(send()).rejects.toThrow(/Wallet or network changed/);
    expect(walletRequest.mock.calls.some(([call]) => call.method === "eth_sendTransaction")).toBe(false);
  });
  it("preserves the hash and requested call if RPC fails immediately after broadcast", async () => {
    mocks.rpc.getTransaction.mockRejectedValueOnce(Error("RPC interrupted"));
    await expect(send()).rejects.toThrow("RPC interrupted");
    expect(client.pending(account)).toMatchObject({ hash: txHash, requested: { from: account, to: market, input: data, value: "0" } });
    await expect(send()).rejects.toThrow(/pending transaction/);
    await expect(client.reconcile(account)).resolves.toMatchObject({ equivalent: true });
    expect(client.pending(account)).toBeNull();
  });
  it("retains a wallet-returned hash whose transaction differs from the reviewed call", async () => {
    transaction.input = "0xdeadbeef";
    await expect(send()).rejects.toThrow(/differs/);
    await expect(client.reconcile(account)).rejects.toThrow(/does not match/);
    expect(client.pending(account)?.hash).toBe(txHash);
  });
  it("identifies nonce replacement without reporting the original action successful", async () => {
    savePending(client.key(account), txHash, { from: account, to: market, input: data, value: "0", nonce: 7, submittedBlock: "9" });
    transaction.input = "0xdeadbeef";
    const result = await client.reconcile(account, txHash);
    expect(result?.equivalent).toBe(false); expect(client.pending(account)).toBeNull();
  });
  it("does not clear a pending record when its receipt is not canonical", async () => {
    savePending(client.key(account), txHash, { from: account, to: market, input: data, value: "0", nonce: 7, submittedBlock: "9" });
    receipt.blockHash = hash("c");
    await expect(client.reconcile(account, txHash)).rejects.toThrow(/not in the canonical block/);
    expect(client.pending(account)?.hash).toBe(txHash);
  });
  it("does not submit when durable storage is unavailable", async () => {
    const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw Error("disabled"); });
    try { await expect(send()).rejects.toThrow(/storage is unavailable/); expect(provider.request).not.toHaveBeenCalled(); }
    finally { spy.mockRestore(); }
  });
  it("resets a partial USDG allowance then approves only the requested amount", async () => {
    mocks.rpc.readContract.mockResolvedValue(2n);
    const writes = vi.spyOn(client, "send").mockResolvedValue(receipt as never);
    await client.approveUSDG(provider, account, 15n, () => {});
    expect(writes.mock.calls.map(call => decodeFunctionData({ abi: erc20Abi, data: call[3] }).args)).toEqual([[market, 0n], [market, 15n]]);
    expect(writes.mock.calls.every(call => call[2] === token)).toBe(true);
  });
  it("rejects stale NFT ownership before requesting approval", async () => {
    mocks.rpc.readContract.mockResolvedValue(collection);
    await expect(client.approveNFT(provider, account, collection, 0n, () => {})).rejects.toThrow(/no longer owns/);
    expect(provider.request).not.toHaveBeenCalled();
  });
  it("rejects duplicate collection identities and incorrect token decimals", () => {
    expect(() => validateNFTConfig({ ...config, collections: [...config.collections, ...config.collections] })).toThrow();
    expect(() => validateNFTConfig({ ...config, loanDecimals: 18 })).toThrow();
  });
});

const loanTerms = { borrower: address("5"), collection, tokenId: 1056n, principal: 20_000000n, interest: 10_000000n, duration: 86400n, expiresAt: 2_000_000_000n };
function fundingFixture() {
  transaction.input = encodeFunctionData({ abi: nftLendingAbi, functionName: "createOffer", args: [loanTerms] });
  receipt.logs = [{ address: market, topics: encodeEventTopics({ abi: nftLendingAbi, eventName: "OfferCreated", args: { id: 1n, lender: account, collection } }),
    data: encodeAbiParameters([{type:"address"},{type:"uint256"},{type:"uint256"},{type:"uint256"},{type:"uint256"},{type:"uint256"},{type:"address"}],
      [loanTerms.borrower,1056n,20_000000n,10_000000n,86400n,2_000_000_000n,address("6")]) }];
  savePending(client.key(account), txHash, { from: account, to: market, input: transaction.input as Hex, value: "0", nonce: 7, submittedBlock: "9" });
}
it("persists the created offer before clearing its pending receipt, including after reopening", async () => {
  fundingFixture();
  const reopened = new NFTClient(config, "http://127.0.0.1:1");
  await reopened.reconcile(account);
  expect(reopened.lastFunding(account)).toEqual({id:"1",hash:txHash});
  expect(reopened.pending(account)).toBeNull();
});
it("retains pending funding when storing the confirmed offer fails", async () => {
  fundingFixture();
  const original = Storage.prototype.setItem;
  const storage = vi.spyOn(Storage.prototype,"setItem").mockImplementation(function(this: Storage,key,value) {
    if (key.endsWith(":funded")) throw Error("disk full");
    return original.call(this,key,value);
  });
  try { await expect(client.reconcile(account)).rejects.toThrow("disk full"); expect(client.pending(account)).not.toBeNull(); }
  finally { storage.mockRestore(); }
  await client.reconcile(account);
  expect(client.lastFunding(account)?.id).toBe("1");
});
it("does not clear confirmed funding with a missing or spoofed creation event", async () => {
  fundingFixture(); (receipt.logs as any[])[0].address = collection;
  await expect(client.reconcile(account)).rejects.toThrow(/offer ID could not/);
  expect(client.pending(account)).not.toBeNull();
});
it("recovers an existing open or active offer before requesting any approval or deposit", async () => {
  for (const status of [1,2]) {
    vi.spyOn(client,"accountOffers").mockResolvedValue({offers:[{id:17n,lender:account,terms:loanTerms,status} as any],more:false,nextCursor:1n});
    await expect(client.fundOffer(provider,account,loanTerms,()=>{})).resolves.toEqual({id:17n,existing:true});
  }
  expect(provider.request).not.toHaveBeenCalled();
});
it("prevents simultaneous wallet submissions from separate client instances", async () => {
  let release!: () => void;
  mocks.rpc.call.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
  const first = send();
  await vi.waitFor(() => expect(release).toBeTypeOf("function"));
  const other = new NFTClient(config,"http://127.0.0.1:1");
  await expect(other.send(provider,account,market,data,()=>{})).rejects.toThrow(/another Turret tab/);
  release(); await first;
  expect(walletRequest.mock.calls.filter(([call]) => call.method === "eth_sendTransaction")).toHaveLength(1);
});
it("checks existing offers again inside the wallet lock, before the deposit prompt", async () => {
  vi.spyOn(client,"accountOffers").mockResolvedValue({offers:[{id:17n,lender:account,terms:loanTerms,status:1} as any],more:false,nextCursor:1n});
  const input = encodeFunctionData({abi:nftLendingAbi,functionName:"createOffer",args:[loanTerms]});
  await expect(client.send(provider,account,market,input,()=>{})).rejects.toThrow(/already have offer #17/);
  expect(walletRequest.mock.calls.some(([call])=>call.method==="eth_sendTransaction")).toBe(false);
});

it("rechecks wallet identity after the deposit's history and nonce reads", async () => {
  vi.spyOn(client,"accountOffers").mockResolvedValue({offers:[],more:false,nextCursor:0n});
  mocks.rpc.getTransactionCount.mockImplementation(async()=>{
    walletRequest.mockImplementation(async({method})=>method==="eth_accounts"?[collection]:"0x1237");return 7;
  });
  const input=encodeFunctionData({abi:nftLendingAbi,functionName:"createOffer",args:[loanTerms]});
  await expect(client.send(provider,account,market,input,()=>{})).rejects.toThrow(/Wallet or network changed/);
  expect(walletRequest.mock.calls.some(([call])=>call.method==="eth_sendTransaction")).toBe(false);
});

it('explains an empty USDG balance before approval or deposit, even with existing allowance', async () => {
  vi.spyOn(client,'existingFunding').mockResolvedValue(null);
  mocks.rpc.readContract.mockImplementation(async ({functionName}) => functionName==='ownerOf'?collection:functionName==='allowance'?10000000n:0n);
  const approve=vi.spyOn(client,'approveUSDG');const submit=vi.spyOn(client,'send');
  await expect(client.fundOffer(provider,account,{...loanTerms,borrower:collection,principal:10000000n},()=>{}))
    .rejects.toThrow('You need 10 USDG to deposit this offer. This wallet has 0 USDG on Robinhood Chain.');
  expect(approve).not.toHaveBeenCalled();expect(submit).not.toHaveBeenCalled();expect(walletRequest).not.toHaveBeenCalled();
});

it('reaches the wallet approval request when the lender has enough USDG', async () => {
  vi.spyOn(client,'existingFunding').mockResolvedValue(null);
  const read=mocks.rpc.readContract.getMockImplementation()!;
  mocks.rpc.readContract.mockImplementation(async args => args.functionName==='ownerOf'?collection:args.functionName==='balanceOf'?10000000n:read(args));
  walletRequest.mockImplementation(async({method})=>{if(method==='eth_accounts')return [account];if(method==='eth_chainId')return '0x1237';throw {code:4001,message:'User declined'};});
  await expect(client.fundOffer(provider,account,{...loanTerms,borrower:collection,principal:10000000n},()=>{})).rejects.toMatchObject({code:4001});
  expect(walletRequest.mock.calls.filter(([call])=>call.method==='eth_sendTransaction')).toHaveLength(1);
});

 it('checks the exact repayment balance and fails closed when the balance read fails',async()=>{
   mocks.rpc.readContract.mockResolvedValueOnce(10000000n);
   await expect(client.requireUSDGBalance(account,20000000n,'repay this loan')).rejects.toThrow('You need 20 USDG to repay this loan. This wallet has 10 USDG');
   expect(mocks.rpc.readContract).toHaveBeenLastCalledWith(expect.objectContaining({address:token,functionName:'balanceOf',args:[account]}));
   mocks.rpc.readContract.mockResolvedValueOnce(20000000n);
   await expect(client.requireUSDGBalance(account,20000000n,'repay this loan')).resolves.toBeUndefined();
   mocks.rpc.readContract.mockRejectedValueOnce(Error('RPC unavailable'));
   await expect(client.requireUSDGBalance(account,20000000n,'repay this loan')).rejects.toThrow('RPC unavailable');
   expect(walletRequest).not.toHaveBeenCalled();
 });
