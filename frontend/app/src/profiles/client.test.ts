// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { webcrypto } from "node:crypto";
import { createSiweMessage } from "viem/siwe";
import type { EIP1193Provider } from "viem";
import { defaultWalletAvatar } from "../../../../shared/wallet-avatar.mjs";

const address = "0x1111111111111111111111111111111111111111";
const other = "0x2222222222222222222222222222222222222222";
const initial = { address, avatar: defaultWalletAvatar(address), revision: 0, updatedAt: null };
const selected = { ...defaultWalletAvatar(address), palette: 6 };
const fetchMock = vi.fn();
beforeEach(() => { vi.resetModules(); vi.stubGlobal("crypto", webcrypto); vi.stubGlobal("fetch", fetchMock); fetchMock.mockReset(); });
afterEach(() => vi.unstubAllGlobals());
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });

async function challenge(overrides = {}) {
  const { sha256 } = await import("./client");
  const nonce = "a".repeat(64);
  return { nonce, message: createSiweMessage({ address, chainId: 4663, domain: window.location.host,
    scheme: window.location.protocol.slice(0, -1), uri: `${window.location.origin}/api/profiles/${address}`,
    version: "1", nonce, issuedAt: new Date(), expirationTime: new Date(Date.now() + 300_000), requestId: "avatar-update-0",
    statement: "Save this public Turret wallet avatar. This signature authorizes no token approvals or blockchain transactions.",
    resources: [`urn:turret:avatar:sha256:${await sha256(new TextEncoder().encode(JSON.stringify(selected)))}`, "urn:turret:avatar:revision:0"], ...overrides }) };
}
function wallet() {
  return { request: vi.fn(async ({ method }: { method: string }) => {
    if (method === "eth_accounts") return [address];
    if (method === "eth_chainId") return "0x1237";
    if (method === "personal_sign") return `0x${"ab".repeat(65)}`;
    throw new Error("Unexpected wallet method");
  }) };
}
describe("public profile loading", () => {
  it("deduplicates simultaneous avatar reads and caches the public result for other viewers", async () => {
    const client = await import("./client");
    fetchMock.mockResolvedValue(response(initial));
    const [a, b] = await Promise.all([client.loadProfile(address), client.loadProfile(address.toUpperCase().replace("0X", "0x"))]);
    expect(a).toEqual(b); expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await client.loadProfile(address)).toEqual(initial); expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it("does not cache failed reads or treat a different wallet profile as this wallet", async () => {
    const client = await import("./client");
    fetchMock.mockResolvedValueOnce(response({ error: "Unavailable" }, 503)).mockResolvedValueOnce(response({ ...initial, address: other })).mockResolvedValueOnce(response(initial));
    await expect(client.loadProfile(address)).rejects.toThrow("Unavailable");
    await expect(client.loadProfile(address)).rejects.toThrow("Invalid profile");
    expect(client.cachedProfile(address)).toBeUndefined();
    expect(await client.loadProfile(address)).toEqual(initial);
  });
});
describe("avatar-only wallet signatures", () => {
  it("saves only the signed avatar and publishes it to every subscriber", async () => {
    const client = await import("./client"), provider = wallet(), notify = vi.fn();
    client.subscribeProfiles(notify);
    const updated = { ...initial, avatar: selected, revision: 1, updatedAt: Date.now() };
    fetchMock.mockResolvedValueOnce(response(await challenge())).mockResolvedValueOnce(response(updated));
    expect(await client.saveProfile({ profile: initial, avatar: selected, provider: provider as unknown as EIP1193Provider })).toEqual(updated);
    expect(client.cachedProfile(address)).toEqual(updated); expect(notify).toHaveBeenCalledOnce();
    const save = JSON.parse(fetchMock.mock.calls[1]![1].body);
    expect(Object.keys(save).sort()).toEqual(["nonce", "signature"]);
    expect(provider.request.mock.calls.filter(([arg]) => arg.method === "personal_sign")).toHaveLength(1);
    expect(provider.request.mock.calls.some(([arg]) => /sendTransaction|signTransaction|typedData/i.test(arg.method))).toBe(false);
  });
  it.each([{ domain: "evil.example" }, { chainId: 1 }, { resources: ["urn:turret:avatar:sha256:wrong"] }, { requestId: "avatar-update-8" }, { expirationTime: new Date(0) }])("rejects a challenge with altered scope before any signature: %j", async override => {
    const client = await import("./client"), provider = wallet();
    fetchMock.mockResolvedValue(response(await challenge(override)));
    await expect(client.saveProfile({ profile: initial, avatar: selected, provider: provider as unknown as EIP1193Provider })).rejects.toThrow("signing request");
    expect(provider.request.mock.calls.some(([arg]) => arg.method === "personal_sign")).toBe(false);
  });
  it("does not save when the wallet changes while its signature prompt is open", async () => {
    const client = await import("./client"); let current = true;
    const provider = { request: vi.fn(async ({ method }: { method: string }) => {
      if (method === "eth_accounts") return [address]; if (method === "eth_chainId") return "0x1237";
      current = false; return `0x${"ab".repeat(65)}`;
    }) };
    fetchMock.mockResolvedValueOnce(response(await challenge()));
    await expect(client.saveProfile({ profile: initial, avatar: selected, provider: provider as unknown as EIP1193Provider, isCurrent: () => current })).rejects.toThrow("wallet changed");
    expect(fetchMock).toHaveBeenCalledTimes(1); expect(client.cachedProfile(address)).toBeUndefined();
  });
  it("leaves the profile unchanged when the signature is declined", async () => {
    const client = await import("./client");
    const provider = wallet(); provider.request.mockImplementation(async ({ method }) => {
      if (method === "eth_accounts") return [address]; if (method === "eth_chainId") return "0x1237";
      throw Object.assign(new Error("User rejected signature"), { code: 4001 });
    });
    fetchMock.mockResolvedValueOnce(response(await challenge()));
    await expect(client.saveProfile({ profile: initial, avatar: selected, provider: provider as unknown as EIP1193Provider })).rejects.toThrow(/rejected/i);
    expect(fetchMock).toHaveBeenCalledTimes(1); expect(client.cachedProfile(address)).toBeUndefined();
  });
  it("rejects unsupported and oversized photos before image decoding", async () => {
    const { prepareProfilePhoto } = await import("./client");
    await expect(prepareProfilePhoto(new File(["<svg/>"], "x.svg", { type: "image/svg+xml" }))).rejects.toThrow("PNG, JPEG or WebP");
    await expect(prepareProfilePhoto(new File([new Uint8Array(10 * 1024 * 1024 + 1)], "x.png", { type: "image/png" }))).rejects.toThrow("under 10 MB");
  });
});
