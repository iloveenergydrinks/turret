import { expect, test, vi } from "vitest";
import { fetchRiskApproval } from "./dockyard-risk-approval";
const address = "0x1111111111111111111111111111111111111111" as const;
const encoded = `0x${"ab".repeat(320)}`;
const valid = () => ({ chainId: 4663, vault: address, adapter: address, collateral: address, encoded, validUntil: Math.floor(Date.now() / 1000) + 40 });
test("only the requested chain, vault, market and adapter approval is accepted", async () => {
  const fetcher = vi.fn(async () => new Response(JSON.stringify(valid())));
  expect(await fetchRiskApproval("https://risk.example", address, address, address, fetcher)).toBe(encoded);
  for (const change of [{ chainId: 1 }, { vault: "0x22" }, { adapter: "0x22" }, { collateral: "0x22" }, { encoded: "0x12" }, { validUntil: 1 }, { validUntil: Math.floor(Date.now() / 1000) + 3600 }]) {
    fetcher.mockImplementation(async () => new Response(JSON.stringify({ ...valid(), ...change })));
    await expect(fetchRiskApproval("https://risk.example", address, address, address, fetcher)).rejects.toThrow();
  }
});
test("monitor outages and unsafe endpoints never fall back to unchecked borrowing", async () => {
  await expect(fetchRiskApproval("https://risk.example", address, address, address, async () => new Response("", { status: 503 }))).rejects.toThrow("temporarily unavailable");
  await expect(fetchRiskApproval("http://risk.example", address, address, address)).rejects.toThrow("Invalid risk monitor");
});
