// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { zeroAddress, type Address, type EIP1193Provider } from "viem";
import { P2PClient, validateDeployment, validateP2PRegistry, type Deployment, type Terms } from "./client";
import { P2P_ASSETS, P2P_USDG } from "./asset-catalog";

const lender = "0x1111111111111111111111111111111111111111" as Address;
const borrower = "0x2222222222222222222222222222222222222222" as Address;
const market = "0x3333333333333333333333333333333333333333" as Address;
const config: Deployment = { chainId: 31337, chainName: "Local", rpcUrl: "/api/p2p-rpc", address: market,
  loanToken: "0x4444444444444444444444444444444444444444", collateralToken: "0x5555555555555555555555555555555555555555",
  loanSymbol: "USDG", collateralSymbol: "AAPL", loanDecimals: 6, collateralDecimals: 18,
  version: 2, runtimeHash: `0x${"a".repeat(64)}`, startBlock: "1" };
const provider = {} as EIP1193Provider;
const row = (status = 1, named: Address = zeroAddress, expiry = 2000n) => [lender, named, 50_000_000_000n, 4n * 10n ** 18n, 8_000_000_000n, 19n * 86400n, expiry, 0n, status] as const;
function connection() {
  const client = new P2PClient(config); client.account = borrower;
  vi.spyOn(client, "verify").mockResolvedValue({ number: 123n, timestamp: 1000n } as never);
  const read = vi.spyOn(client.publicClient, "readContract");
  read.mockImplementation((async ({ functionName }: { functionName: string }) => {
    if (functionName === "offers") return row();
    if (functionName === "isPublicOffer") return true;
    if (functionName === "offerCreatedAt") return 900n;
    if (functionName === "newLoansPaused") return false;
    if (functionName === "getPublicOfferIds" || functionName === "getAccountOfferIds") return [[1n], 0n];
    return 0n;
  }) as never);
  vi.spyOn(client.publicClient, "getBalance").mockResolvedValue(10n ** 18n);
  // Exercise public validation and read paths without requesting a wallet signature.
  const write = vi.spyOn(client as never as { write: (...args: unknown[]) => Promise<string> }, "write").mockResolvedValue("submitted");
  return { client, read, write };
}
const terms: Terms = { borrower: zeroAddress, principal: 50_000_000_000n, collateral: 4n * 10n ** 18n,
  interest: 8_000_000_000n, durationDays: 19, expiresAt: 1000 + 10 * 86400 };
beforeEach(() => { vi.restoreAllMocks(); window.localStorage.clear(); sessionStorage.clear(); });

describe("reviewed market registry", () => {
  it("allows all reviewed identities only with their canonical token address", () => {
    for (const asset of P2P_ASSETS) {
      const production = { ...config, chainId: 4663, loanToken: P2P_USDG, collateralToken: asset.address, collateralSymbol: asset.symbol };
      expect(validateDeployment(production, "turret.capital").collateralSymbol).toBe(asset.symbol);
      expect(() => validateDeployment({ ...production, collateralToken: config.collateralToken }, "turret.capital")).toThrow(/identities/);
    }
  });
  it("accepts the full RH catalog with existing assets and the legacy pilot", () => {
    const markets = P2P_ASSETS.map((asset, i) => ({ ...config, chainId: 4663,
      address: `0x${(10000 + i).toString(16).padStart(40, "0")}`, loanToken: P2P_USDG,
      collateralToken: asset.address, collateralSymbol: asset.symbol }));
    const slv = markets.find(m => m.collateralSymbol === "SLV")!;
    const legacy = { ...slv, version: 1, legacy: true, address: `0x${"9".repeat(40)}` };
    expect(markets.length).toBeGreaterThan(190);
    const value = { schemaVersion: 2, markets: [...markets, legacy], unavailableAssets: [] };
    expect(validateP2PRegistry(value, "turret.capital").markets).toHaveLength(P2P_ASSETS.length + 1);
    expect(() => validateP2PRegistry({ ...value, markets: Array(P2P_ASSETS.length * 2 + 2).fill(config) }, "turret.capital")).toThrow(/configuration/);
  });
  it("shares read transport without sharing account state or permitting network mixes", () => {
    const first = new P2PClient(config);
    const second = new P2PClient({ ...config, address: borrower }, first);
    first.account = lender;
    expect(second.publicClient).toBe(first.publicClient);
    expect(second.account).toBeNull();
    expect(() => new P2PClient({ ...config, rpcUrl: "/api/other" }, first)).toThrow(/different networks/);
  });
  it("rejects local chains on public hosts, network mixes and duplicate active assets", () => {
    expect(() => validateDeployment(config, "turret.capital")).toThrow(/local-chain/);
    const validate = (markets: unknown[]) => validateP2PRegistry({ schemaVersion: 2, markets, unavailableAssets: [] }, "localhost");
    expect(() => validate([config, config])).toThrow(/overlap/);
    expect(() => validate([config, { ...config, address: borrower }])).toThrow(/Duplicate/);
    expect(() => validate([config, { ...config, address: borrower, rpcUrl: "/api/other" }])).toThrow(/networks/);
    expect(() => validateP2PRegistry({ schemaVersion: 2, markets: [config], unavailableAssets: [{ symbol: "AAPL", name: "Apple", address: config.collateralToken, reason: "Paused" }] }, "localhost")).toThrow(/Unavailable/);
  });
  it("retains a separate legacy SLV market alongside V2", () => {
    const legacy = { ...config, version: 1, legacy: true, address: borrower, collateralSymbol: "SLV" };
    expect(validateP2PRegistry({ schemaVersion: 2, markets: [config, legacy], unavailableAssets: [] }, "localhost").markets).toHaveLength(2);
  });
});

describe("public offers and custom terms", () => {
  it("funds a public offer with custom duration, high principal and fixed interest", async () => {
    const { client, write } = connection();
    await client.createOffer(provider, terms, vi.fn());
    expect(write).toHaveBeenCalledWith(provider, "createOffer", [zeroAddress, terms.principal, terms.collateral, terms.interest, 19n * 86400n, BigInt(terms.expiresAt)], expect.any(Function), { token: config.loanToken, amount: terms.principal }, undefined);
  });
  it("allows zero interest and a private designated borrower", async () => {
    const { client, write } = connection(); client.account = lender;
    await client.createOffer(provider, { ...terms, interest: 0n, borrower }, vi.fn());
    expect(write).toHaveBeenCalledOnce();
  });
  it.each([
    ["zero principal", { principal: 0n }], ["zero collateral", { collateral: 0n }],
    ["fractional days", { durationDays: 1.5 }], ["negative interest", { interest: -1n }],
    ["overflow", { principal: (1n << 256n) - 1n }], ["past expiry", { expiresAt: 1000 }],
    ["calendar overflow", { expiresAt: 8_640_000_000_000 }], ["self borrower", { borrower }],
  ])("rejects %s before approval", async (_name, change) => {
    const { client, write } = connection();
    await expect(client.createOffer(provider, { ...terms, ...change }, vi.fn())).rejects.toThrow();
    expect(write).not.toHaveBeenCalled();
  });
  it("accepts public offers and rejects self-acceptance, stale offers and private restrictions", async () => {
    const { client, read, write } = connection();
    await client.accept(provider, 1n, vi.fn()); expect(write).toHaveBeenCalledOnce(); write.mockClear();
    client.account = lender;
    await expect(client.accept(provider, 1n, vi.fn())).rejects.toThrow(/different from the lender/);
    client.account = borrower; read.mockResolvedValueOnce(row(2));
    await expect(client.accept(provider, 1n, vi.fn())).rejects.toThrow(/no longer available/);
    read.mockResolvedValueOnce(row(1, market));
    await expect(client.accept(provider, 1n, vi.fn())).rejects.toThrow(/named borrower/);
    read.mockResolvedValueOnce(row(1, zeroAddress, 1000n));
    await expect(client.accept(provider, 1n, vi.fn())).rejects.toThrow(/expired/);
    expect(write).not.toHaveBeenCalled();
  });
});

describe("public discovery and account isolation", () => {
  it("reads disconnected offers at a single verified block and retains pagination", async () => {
    const { client, read } = connection(); client.disconnect();
    read.mockImplementation((async ({ functionName, args }: { functionName: string; args: bigint[] }) => {
      if (functionName === "getPublicOfferIds") return [[3n, 2n, 1n], 7n];
      if (functionName === "offers") return row(args[0] === 3n ? 2 : 1, zeroAddress, args[0] === 2n ? 999n : 2000n);
      if (functionName === "isPublicOffer") return true;
      if (functionName === "offerCreatedAt") return 900n;
      return false;
    }) as never);
    const page = await client.browse(10n);
    expect(page.offers.map(offer => offer.id)).toEqual([1n]); expect(page.nextCursor).toBe(7n);
    expect(page.offers[0]).toMatchObject({ isPublic: true, createdAt: 900, durationDays: 19 });
    for (const [request] of read.mock.calls) expect(request.blockNumber).toBe(123n);
  });
  it("rejects a non-advancing public index", async () => {
    const { client, read } = connection(); read.mockResolvedValueOnce(false).mockResolvedValueOnce([[1n], 10n]);
    await expect(client.browse(10n)).rejects.toThrow(/Invalid public offer page/);
  });
  it("indexes a wallet's loans without pilot caps or lender permission RPCs", async () => {
    const { client, read } = connection(); client.account = lender;
    const snapshot = await client.snapshot();
    expect(snapshot).toMatchObject({ approvedLender: true, maxPrincipal: null, maxCommitted: null, balances: { USDG: 0n, COLLATERAL: 0n }, nativeBalance: 10n ** 18n });
    expect(snapshot.offers).toHaveLength(1);
    const methods = read.mock.calls.map(([request]) => request.functionName);
    expect(methods).toContain("getAccountOfferIds");
    for (const method of ["permittedLenders", "maxPrincipalPerLoan", "maxCommittedPrincipal", "nextOfferId"]) expect(methods).not.toContain(method);
  });
  it("rejects an unrelated wallet entry", async () => {
    const { client } = connection();
    await expect(client.snapshot()).rejects.toThrow(/unrelated loan/);
  });
});


describe("INDEX collateral identity", () => {
  it("accepts the requested token address and rejects an unrelated token with the same label", () => {
    const indexConfig = { ...config, chainId: 4663, loanToken: P2P_USDG, collateralSymbol: "INDEX", collateralName: "The Index", collateralToken: "0x56910D4409F3a0C78C64DD8D0545FF0705389870" };
    expect(validateDeployment(indexConfig, "turret.capital").collateralToken).toBe(indexConfig.collateralToken);
    expect(() => validateDeployment({ ...indexConfig, collateralToken: config.collateralToken }, "turret.capital")).toThrow(/reviewed token identities/);
  });
});
