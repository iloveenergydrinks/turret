import { describe, expect, it, vi } from "vitest";
import { keccak256 } from "viem";
import { captureTokenBaseline, inspectP2PHealth, validateTokenBaseline } from "./health-core.mjs";

const address = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
const zero = `0x${"0".repeat(64)}`;
const block = { number: 100n, hash: `0x${"a".repeat(64)}`, timestamp: 1_800_000_000n };
const market = { chainId: 4663, address: address(1), loanToken: address(2), collateralToken: address(3), loanDecimals: 6, collateralDecimals: 18, runtimeHash:keccak256("0x6000") };
function fixture() {
  const tokens = [market.loanToken, market.collateralToken].map((address, i) => ({ address, runtimeHash: keccak256("0x6000"), implementationSlot: zero, beaconSlot: zero, decimals: i ? 18 : 6, checks: ["paused"] }));
  const baseline = { schemaVersion: 1, chainId: 4663, blockNumber: "10", blockHash: block.hash, tokens };
  const client = {
    getCode: vi.fn().mockResolvedValue("0x6000"), getStorageAt: vi.fn().mockResolvedValue(zero),
    getBlock: vi.fn().mockResolvedValue(block),
    readContract: vi.fn(async ({ address, functionName, args }: { address: string; functionName: string; args: string[] }): Promise<string | number | bigint | boolean> => {
      if (functionName === "loanToken") return market.loanToken;
      if (functionName === "collateralToken") return market.collateralToken;
      if (functionName === "decimals") return address === market.loanToken ? 6 : 18;
      if (functionName === "paused" || functionName === "newLoansPaused") return false;
      if (functionName === "balanceOf") return 100n;
      if (functionName === "totalCredits") return args[0] === market.loanToken ? 10n : 20n;
      return 50n;
    }),
  };
  const inspect = () => inspectP2PHealth(client as never, market as never, baseline, block as never, Number(block.timestamp) * 1000);
  return { client, baseline, inspect };
}
describe("new P2P exposure health", () => {
  it("never omits a restriction check because its transport failed during capture", async () => {
    const f=fixture(),read=f.client.readContract.getMockImplementation()!;
    f.client.readContract.mockImplementation(r=>r.functionName === "paused" ? Promise.reject(new Error("network unavailable")) : read(r));
    await expect(captureTokenBaseline(f.client as never,market.loanToken as never,block as never,market.address as never)).rejects.toThrow(/probe/);
  });
  it("marks definitive absent getters unknown across CJS/ESM error constructors", async () => {
    const f=fixture(),read=f.client.readContract.getMockImplementation()!;
    f.client.readContract.mockImplementation(r=>["paused","tokenPaused","isFrozen","isBlocked"].includes(r.functionName)
      ? Promise.reject({name:"ContractFunctionExecutionError",cause:{name:"ContractFunctionRevertedError"}}) : read(r));
    expect((await captureTokenBaseline(f.client as never,market.loanToken as never,block as never,market.address as never)).checks).toEqual([]);
  });
  it("checks backed reserves and credits at a canonical block", async () => {
    const f = fixture(); expect(await f.inspect()).toMatchObject({ status: "ok", reasons: [], blockNumber: "100" });
    expect(f.client.readContract.mock.calls.every(([r]) => (r as unknown as {blockNumber: bigint}).blockNumber === block.number)).toBe(true);
  });
  it("blocks a balance shortfall even when one transfer could still succeed", async () => {
    const f = fixture(), read = f.client.readContract.getMockImplementation()!;
    f.client.readContract.mockImplementation(r => r.functionName === "balanceOf" ? Promise.resolve(59n) : read(r));
    expect(await f.inspect()).toMatchObject({ status: "blocked", reasons: [expect.stringMatching(/shortfall/)] });
  });
  it("blocks runtime changes without silently accepting a new baseline", async () => {
    const f = fixture(); f.client.getCode.mockImplementation(async ({address:a}:{address:string})=>a===market.address ? "0x6000" : "0x6001");
    expect(await f.inspect()).toMatchObject({ status: "blocked", reasons: [expect.stringMatching(/changed/)] });
    expect(f.baseline.tokens[0]!.runtimeHash).toBe(keccak256("0x6000"));
  });
  it("detects implementation changes behind an unchanged beacon proxy", async () => {
    const f = fixture(); const beacon = address(4), implementation = address(5);
    Object.assign(f.baseline.tokens[0]!, { beaconSlot: `0x${"0".repeat(24)}${beacon.slice(2)}`, beacon: { address: beacon, runtimeHash: keccak256("0x6000") }, implementation: { address: implementation, runtimeHash: keccak256("0x6000") } });
    f.client.getStorageAt.mockImplementation(async ({address: a, slot}: {address: string; slot: string}) => a === market.loanToken && slot.startsWith("0xa3f0") ? f.baseline.tokens[0]!.beaconSlot : zero);
    const read=f.client.readContract.getMockImplementation()!;f.client.readContract.mockImplementation(r=>r.functionName === "implementation" ? Promise.resolve(address(6)) as never : read(r));
    expect(await f.inspect()).toMatchObject({ status: "blocked", reasons: [expect.stringMatching(/implementation changed/)] });
  });
  it("requires positively supported restriction methods to keep working", async () => {
    const f=fixture(),read=f.client.readContract.getMockImplementation()!;
    f.client.readContract.mockImplementation(r=>r.functionName === "paused" ? Promise.reject(new Error("private upstream details")) : read(r));
    const result=await f.inspect();expect(result.status).toBe("unavailable");expect(JSON.stringify(result)).not.toContain("private upstream");
  });
  it("does not cache read failures as healthy", async () => {
    const f=fixture();f.client.getCode.mockRejectedValueOnce(new Error("offline"));
    expect((await f.inspect()).status).toBe("unavailable");expect((await f.inspect()).status).toBe("ok");
  });
  it("rejects a stale block, reorg or missing token identity", async () => {
    const f=fixture();expect((await inspectP2PHealth(f.client as never,market as never,f.baseline,block as never,Number(block.timestamp)*1000+181000)).status).toBe("unavailable");
    f.client.getBlock.mockResolvedValue({...block,hash:zero});expect((await f.inspect()).status).toBe("unavailable");
    f.baseline.tokens.pop();expect((await f.inspect()).status).toBe("unavailable");
  });
  it("rejects malformed or unbound proxy baselines", () => {
    const f=fixture();expect(()=>validateTokenBaseline({...f.baseline,chainId:31337},4663)).toThrow();
    Object.assign(f.baseline.tokens[0]!,{implementation:{address:address(5),runtimeHash:keccak256("0x6000")}});
    expect(()=>validateTokenBaseline(f.baseline,4663)).toThrow(/proxy binding/);
  });
  it("does not approve a check that became stale while its reads were pending", async () => {
    const f = fixture(), now = Number(block.timestamp) * 1000;
    const clock = vi.spyOn(Date, "now").mockReturnValueOnce(now).mockReturnValue(now + 181_000);
    try { expect((await f.inspect()).status).toBe("unavailable"); }
    finally { clock.mockRestore(); }
  });
});

describe("isolated V3 vault health", () => {
  function v3() {
    const f = fixture(), impl = address(7), vault = address(8);
    const v3Market = { ...market, version: 3, vaultImplementation: impl, vaultImplementationHash: keccak256("0x6002") };
    const oldRead = f.client.readContract.getMockImplementation()!;
    f.client.getCode.mockImplementation(async ({ address: a }: { address: string }) => a === impl ? "0x6002"
      : a === vault ? `0x363d3d373d3d3d363d73${impl.slice(2)}5af43d82803e903d91602b57fd5bf3` : "0x6000");
    f.client.readContract.mockImplementation((async (r: { address: string; functionName: string; args: string[] }) => {
      if (r.functionName === "manager") return market.address;
      if (r.functionName === "vaultImplementation") return impl;
      if (r.functionName === "vaults") return vault;
      if (r.functionName === "offers") return [address(11), address(12), 100n, 10n, 1n, 86400n, block.timestamp + 10n, 0n, 1];
      if (["reservedPrincipal", "lockedCollateral", "totalCredits"].includes(r.functionName)) throw new Error("V3 nominal counters are not custody");
      if (r.functionName === "balanceOf") return r.args[0] === vault ? 100n : 0n;
      if (r.functionName === "isFrozen") return false;
      return oldRead(r);
    }) as never);
    return { ...f, v3Market, impl, vault, inspect: (id?: bigint) => inspectP2PHealth(f.client as never, v3Market as never, f.baseline, block as never, Number(block.timestamp) * 1000, id) };
  }
  it("does not misclassify a manager with zero custody as globally insolvent", async () => {
    const f = v3();
    expect((await f.inspect()).status).toBe("ok");
    expect(f.client.readContract.mock.calls.map(([r]) => r.functionName)).not.toContain("balanceOf");
  });
  it("verifies the specific accepted offer's immutable vault and complete funding", async () => {
    const f = v3(); expect((await f.inspect(1n)).status).toBe("ok");
    const read = f.client.readContract.getMockImplementation()!;
    f.client.readContract.mockImplementation(r => r.functionName === "balanceOf" ? Promise.resolve(99n) : read(r));
    expect(await f.inspect(1n)).toMatchObject({ status: "blocked", reasons: [expect.stringMatching(/offer's vault has a token shortfall/)] });
    // One defunded offer does not disable creation of unrelated isolated loans.
    expect((await f.inspect()).status).toBe("ok");
  });
  it("rejects substituted implementation code, clone target or manager binding", async () => {
    for (const subject of ["implementation", "clone", "manager"]) {
      const f = v3();
      if (subject === "manager") {
        const read = f.client.readContract.getMockImplementation()!;
        f.client.readContract.mockImplementation(r => r.functionName === "manager" && r.address === f.vault ? Promise.resolve(address(90)) : read(r));
      } else {
        const code = f.client.getCode.getMockImplementation()!;
        f.client.getCode.mockImplementation(r => r.address === (subject === "clone" ? f.vault : f.impl) ? Promise.resolve("0x6003") : code(r));
      }
      expect((await f.inspect(1n)).status).toBe("unavailable");
    }
  });
  it("checks freeze restrictions on each offer vault, beyond its manager", async () => {
    const f = v3(); f.baseline.tokens[0]!.checks.push("isFrozen");
    const read = f.client.readContract.getMockImplementation()!;
    f.client.readContract.mockImplementation(r => r.functionName === "isFrozen" ? Promise.resolve(r.args[0] === f.vault) : read(r));
    expect((await f.inspect()).status).toBe("ok");
    expect(await f.inspect(1n)).toMatchObject({ status: "blocked", reasons: [expect.stringMatching(/loan vault are restricted/)] });
  });
});
