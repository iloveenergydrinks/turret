// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { zeroAddress, type Address, type EIP1193Provider } from "viem";
import { P2PClient, validateDeployment, validateP2PRegistry, type Deployment, type Loan, type ExtensionProposal } from "./client";

const address = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address;
const lender = address(1), borrower = address(2), vault = address(6);
const config: Deployment = { chainId: 31337, chainName: "Local", rpcUrl: "/api/p2p-rpc", address: address(3), loanToken: address(4), collateralToken: address(5),
  loanSymbol: "USDG", collateralSymbol: "AAPL", loanDecimals: 6, collateralDecimals: 18, version: 3,
  runtimeHash: `0x${"a".repeat(64)}`, startBlock: "1", vaultImplementation: address(7), vaultImplementationHash: `0x${"b".repeat(64)}` };
const provider = {} as EIP1193Provider;
const extension: ExtensionProposal = { proposer: lender, nonce: 1n, oldDeadline: 1000, newDeadline: 2000, expiresAt: 1800 };
function loan(id = 1n): Loan {
  return { id, lender, borrower, principal: 100n, collateral: 10n, interest: 10n, durationDays: 1, createdAt: 1, expiresAt: 10,
    dueAt: 100, repaymentDeadline: 1000, status: "active", isPublic: true, vault, extensionProposal: { ...extension },
    loanCredits: { USDG: { beneficiary: borrower, nominal: 100n, available: 50n }, COLLATERAL: { beneficiary: zeroAddress, nominal: 0n, available: 0n } } };
}
function connection() {
  const client = new P2PClient(config); client.account = borrower;
  vi.spyOn(client, "verify").mockResolvedValue({ number: 123n, hash: `0x${"c".repeat(64)}`, timestamp: 1500n } as never);
  const get = vi.spyOn(client, "getLoan").mockImplementation(async id => loan(id));
  const write = vi.spyOn(client as never as { write: (...args: unknown[]) => Promise<string> }, "write").mockResolvedValue("submitted");
  return { client, get, write };
}
beforeEach(() => { vi.restoreAllMocks(); window.localStorage.clear(); sessionStorage.clear(); });

describe("V3 registry and reads", () => {
  it("pins public offer pages to the requested historical block and rejects future anchors",async()=>{
    const {client}=connection();
    const blockHash=`0x${"c".repeat(64)}`;
    const blocks=vi.spyOn(client.publicClient,"getBlock").mockResolvedValue({number:120n,hash:blockHash,timestamp:1490n} as never);
    const reads=vi.spyOn(client.publicClient,"readContract").mockImplementation((async ({functionName}:{functionName:string})=>{
      if(functionName==="getPublicOfferIds")return [[],0n];
      if(functionName==="newLoansPaused")return false;
      throw new Error("Unsupported health fixture read");
    }) as never);
    const result=await client.browse(40n,120n);
    expect(result.blockNumber).toBe(120n);
    expect(blocks).toHaveBeenCalledWith({blockNumber:120n});
    expect(reads).toHaveBeenCalledWith(expect.objectContaining({functionName:"getPublicOfferIds",args:[40n,40n],blockNumber:120n}));
    await expect(client.browse(40n,124n)).rejects.toThrow("Invalid offer observation block");
  });
  it("does not publish a zero-credit result after an account change or chain reorganization", async () => {
    const { client } = connection();
    const blockHash = `0x${"c".repeat(64)}`;
    const blocks = vi.spyOn(client.publicClient, "getBlock").mockResolvedValue({ number: 123n, hash: blockHash } as never);
    const reads = vi.spyOn(client.publicClient, "readContract").mockImplementation((async (request: { functionName: string }) => request.functionName === "getAccountOfferIds" ? [[], 0n] : 0n) as never);
    expect(await client.creditPage()).toMatchObject({ loans: [], nextCursor: null });
    expect(blocks).toHaveBeenCalledTimes(2);
    blocks.mockReset().mockResolvedValueOnce({ number: 123n, hash: blockHash } as never).mockResolvedValue({ number: 123n, hash: config.runtimeHash } as never);
    await expect(client.creditPage()).rejects.toThrow("Withdrawal history changed");
    blocks.mockResolvedValue({ number: 123n, hash: blockHash } as never);
    reads.mockImplementation((async (request: { functionName: string }) => { if (request.functionName === "credits") client.account = lender; return request.functionName === "getAccountOfferIds" ? [[], 0n] : 0n; }) as never);
    await expect(client.creditPage()).rejects.toThrow("Withdrawal history changed");
  });
  it("requires a pinned implementation and permits separately retained V2 markets", () => {
    expect(validateDeployment(config, "localhost").version).toBe(3);
    expect(() => validateDeployment({ ...config, vaultImplementationHash: undefined }, "localhost")).toThrow(/vault implementation/);
    const retained = { ...config, address: address(8), version: 2, legacy: true };
    const registry = (markets: unknown[]) => validateP2PRegistry({ schemaVersion: 2, markets, unavailableAssets: [] }, "localhost");
    expect(registry([config, retained]).markets).toHaveLength(2);
    expect(() => registry([config, { ...retained, legacy: false }])).toThrow(/Duplicate active/);
    expect(() => registry([config, retained, { ...retained, address: address(9) }])).toThrow(/Duplicate retained/);
  });
  it("reads actual backing separately from nominal credit and exact mutable final deadline", async () => {
    const { client, get } = connection(); get.mockRestore();
    const read = vi.spyOn(client.publicClient, "readContract").mockImplementation((async (r: { functionName: string; args?: readonly unknown[] }) => {
      switch (r.functionName) {
        case "offers": return [lender, borrower, 100n, 10n, 10n, 86400n, 100n, 200n, 2];
        case "isPublicOffer": return true;
        case "offerCreatedAt": return 20n;
        case "vaults": return vault;
        case "repaymentDeadline": return 300000n;
        case "loanCredit": return r.args?.[1] === config.loanToken ? [borrower, 100n, 50n] : [zeroAddress, 0n, 0n];
        case "extensionProposals": return [lender, 3n, 300000n, 400000n, 350000n];
        case "balanceOf": return 50n;
        default: throw new Error(r.functionName);
      }
    }) as never);
    expect(await client.getLoan(1n)).toMatchObject({ vault, repaymentDeadline: 300000, fundingAvailable: 50n, loanCredits: { USDG: { nominal: 100n, available: 50n } }, extensionProposal: { nonce: 3n, newDeadline: 400000 } });
    expect(read.mock.calls.every(([request]) => request.blockNumber === 123n)).toBe(true);
    const working = read.getMockImplementation()!;
    read.mockImplementation((async (request: Parameters<typeof working>[0]) => {
      if (request.functionName === "balanceOf" || (request.functionName === "loanCredit" && request.args?.[1] === config.loanToken)) throw new Error("USDG balance reads unavailable");
      return working(request);
    }) as never);
    expect(await client.getLoan(1n)).toMatchObject({ repaymentDeadline: 300000, fundingAvailable: undefined,
      loanCredits: { USDG: { unavailable: true }, COLLATERAL: { nominal: 0n, available: 0n } } });
  });
  it("requires a per-loan credit instead of calling V2's pooled withdrawal", () => {
    const { client, write } = connection();
    expect(() => client.withdraw(provider, "USDG", 50n, borrower, vi.fn())).toThrow(/individual loan vault/);
    expect(write).not.toHaveBeenCalled();
  });
});

describe("V3 withdrawal and repayment authorization", () => {
  it("withdraws only the available portion and preserves nominal remainder", async () => {
    const { client, write } = connection();
    await client.withdrawCredit(provider, 1n, "USDG", 50n, borrower, vi.fn());
    expect(write).toHaveBeenCalledWith(provider, "withdrawCredit", [1n, config.loanToken, 50n, borrower], expect.any(Function));
    write.mockClear();
    await expect(client.withdrawCredit(provider, 1n, "USDG", 51n, borrower, vi.fn())).rejects.toThrow(/available credit/);
    client.account = lender;
    await expect(client.withdrawCredit(provider, 1n, "USDG", 1n, lender, vi.fn())).rejects.toThrow(/owned by your wallet/);
    expect(write).not.toHaveBeenCalled();
  });
  it("pins the explicitly chosen minimum when closing a deficient claim", async () => {
    const { client, write } = connection();
    await client.withdrawAvailableCredit(provider, 1n, "USDG", 50n, borrower, vi.fn());
    expect(write).toHaveBeenCalledWith(provider, "withdrawAvailableCredit", [1n, config.loanToken, 50n, borrower], expect.any(Function));
    await expect(client.withdrawAvailableCredit(provider, 1n, "USDG", 51n, borrower, vi.fn())).rejects.toThrow(/minimum/);
    await expect(client.withdrawAvailableCredit(provider, 1n, "USDG", 0n, vault, vi.fn())).rejects.toThrow(/recipient/);
  });
  it("allows another payer to use only their own credits while keeping the original borrower", async () => {
    const { client, write, get } = connection(); client.account = lender;
    get.mockImplementation(async id => ({ ...loan(id), loanCredits: { ...loan(id).loanCredits!, USDG: { beneficiary: lender, nominal: 100n, available: 100n } } }));
    await client.repayWithCredits(provider, 3n, [1n], [100n], 10n, vi.fn());
    expect(write).toHaveBeenCalledWith(provider, "repayWithCredits", [3n, [1n], [100n], 10n], expect.any(Function), { token: config.loanToken, amount: 10n });
    expect((await client.getLoan(3n)).borrower).toBe(borrower);
  });
  it("repays using owned backed sources plus exactly the remaining wallet amount", async () => {
    const { client, write } = connection();
    await client.repayWithCredits(provider, 3n, [1n, 2n], [50n, 50n], 10n, vi.fn());
    expect(write).toHaveBeenCalledWith(provider, "repayWithCredits", [3n, [1n, 2n], [50n, 50n], 10n], expect.any(Function), { token: config.loanToken, amount: 10n });
    write.mockClear();
    await client.repayWithCredits(provider, 4n, [1n, 2n, 3n], [50n, 50n, 10n], 0n, vi.fn());
    expect(write).toHaveBeenCalledWith(provider, "repayWithCredits", expect.anything(), expect.any(Function), undefined);
  });
  it.each([
    [[2n, 1n], [50n, 50n], 10n], [[1n, 1n], [50n, 50n], 10n], [[3n], [50n], 60n], [[1n], [51n], 59n],
    [[1n], [50n], 59n], [[1n], [0n], 110n], [Array.from({ length: 17 }, (_, i) => BigInt(i + 4)), Array(17).fill(1n), 93n],
  ])("rejects invalid or unbacked credit selection before signing (%s)", async (ids, amounts, wallet) => {
    const { client, write } = connection();
    await expect(client.repayWithCredits(provider, 3n, ids as bigint[], amounts as bigint[], wallet as bigint, vi.fn())).rejects.toThrow();
    expect(write).not.toHaveBeenCalled();
  });
});

describe("V3 mutually agreed extensions", () => {
  it("allows an overdue unclaimed loan to be proposed for extension", async () => {
    const { client, write } = connection();
    await client.proposeExtension(provider, 1n, 2000, 1900, vi.fn());
    expect(write).toHaveBeenCalledWith(provider, "proposeExtension", [1n, 2000n, 1900n], expect.any(Function));
    await expect(client.proposeExtension(provider, 1n, 1400, 1600, vi.fn())).rejects.toThrow(/later final deadline/);
  });
  it("accepts the exact observed proposal and rejects replacement or self-acceptance", async () => {
    const { client, write, get } = connection();
    await client.acceptExtension(provider, 1n, extension, vi.fn());
    expect(write).toHaveBeenCalledWith(provider, "acceptExtension", [1n, 1n, 1000n, 2000n, 1800n], expect.any(Function));
    write.mockClear(); get.mockResolvedValue({ ...loan(), extensionProposal: { ...extension, nonce: 2n } });
    await expect(client.acceptExtension(provider, 1n, extension, vi.fn())).rejects.toThrow(/changed/);
    get.mockResolvedValue(loan()); client.account = lender;
    await expect(client.acceptExtension(provider, 1n, extension, vi.fn())).rejects.toThrow(/cannot be accepted/);
    expect(write).not.toHaveBeenCalled();
  });
});
