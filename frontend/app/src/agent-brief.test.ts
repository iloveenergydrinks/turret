import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import matter from "gray-matter";
import { getAgentBrief } from "./agent-brief";
import { AGENT_BRIEF_SLUG, AGENT_SHARE_URL } from "./agent-brief-config";
import { SOCIAL_IMAGE } from "./social-metadata";
import { GET as getMarkdown } from "./app/agent-brief.md/route";
import { GET as getIndex } from "./app/llms.txt/route";

describe("agent due diligence materials", () => {
  it("publishes the same reviewed body to agents and humans", async () => {
    const source = readFileSync(`content/blog/${AGENT_BRIEF_SLUG}.md`, "utf8");
    const body = matter(source).content.trim();
    const brief = getAgentBrief();
    expect(brief).toContain(body);
    expect(brief).toContain(AGENT_SHARE_URL);
    expect(brief).not.toContain("draft: false");
    const response = getMarkdown();
    expect(response.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    expect(await response.text()).toBe(brief);
  });
  it("makes provenance, limitations, owner control, and liquidation explicit", () => {
    const brief = getAgentBrief();
    for (const text of ["not an audit", "source repository is private", "No independent audit report", "50.0025 USDG", "52,597,522", "Owner powers", "liquidation", "need no wallet"]) {
      expect(brief.toLowerCase()).toContain(text.toLowerCase());
    }
    expect(brief).not.toContain("github.com/iloveenergydrinks");
    expect(brief).not.toMatch(/cast (send|wallet)|--private-key/);
  });
  it("provides a dated, unit-labelled ten-market snapshot", () => {
    const snapshot = JSON.parse(readFileSync("public/evidence/mainnet-2026-09-02.json", "utf8"));
    expect(snapshot.chainId).toBe(4663);
    expect(snapshot.blockNumber).toBe("52597522");
    expect(snapshot.usdgDecimals).toBe(6);
    expect(snapshot.markets).toHaveLength(10);
    expect(snapshot.runtimeCodeKeccak256).toMatch(/^0x[0-9a-f]{64}$/);
    expect(snapshot.provenance).toContain("not an audit");
    for (const market of snapshot.markets) {
      expect(market.collateral).toMatch(/^0x[0-9a-fA-F]{40}$/);
      expect(market.primaryOracle).not.toBe(market.secondaryOracle);
      expect(market.maxLtvBps).toBeLessThan(market.liquidationLtvBps);
    }
  });
  it("has a discoverable text index and a real 2:1 sharing image", async () => {
    const response = getIndex();
    expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    const text = await response.text();
    expect(text).toContain("https://turret.capital/agent-brief.md");
    expect(text).toContain(AGENT_SHARE_URL);
    expect(text).toContain("not an independent audit");
    const png = readFileSync(`public${new URL(SOCIAL_IMAGE.url).pathname}`);
    expect(png.subarray(1, 4).toString()).toBe("PNG");
    expect(png.readUInt32BE(16)).toBe(SOCIAL_IMAGE.width);
    expect(png.readUInt32BE(20)).toBe(SOCIAL_IMAGE.height);
    expect(SOCIAL_IMAGE.width / SOCIAL_IMAGE.height).toBe(2);
    expect(png.length).toBeLessThan(5_000_000);
  });
});
