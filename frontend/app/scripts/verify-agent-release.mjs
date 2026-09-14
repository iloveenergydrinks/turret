import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { request } from "node:http";

const base = process.argv[2] || "http://127.0.0.1:3041";
const local = new URL(base).hostname === "127.0.0.1";
const imagePath = "/brand/dockyard-social-v1.png";
const sharePath = "/understand-dockyard";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
async function get(path, blog = false, extraHeaders = {}) {
  const origin = local ? base : blog ? "https://blog.turret.capital" : base;
  const headers = { "user-agent": "Twitterbot/1.0", ...(local ? { Host: blog ? "blog.turret.capital" : "turret.capital" } : {}), ...extraHeaders };
  // Node fetch can normalize Host. Use HTTP directly to exercise virtual hosts locally.
  const response = local ? await new Promise((resolve, reject) => {
    const req = request(`${origin}${path}`, { headers }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve(new Response(Buffer.concat(chunks), { status: res.statusCode, headers: res.headers })));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end();
  }) : await fetch(`${origin}${path}`, { headers, redirect: "manual" });
  assert.equal(response.status, extraHeaders.Range ? 206 : 200, `${origin}${path}`);
  return response;
}
for (const blog of [false, true]) {
  const markdown = await get("/agent-brief.md", blog);
  assert.match(markdown.headers.get("content-type"), /^text\/markdown;/);
  assert.equal(markdown.headers.get("cache-control"), "no-store");
  const body = await markdown.text();
  assert.ok(body.startsWith("# Understand Dockyard\n"));
  assert.ok(body.includes("source repository is private"));
  assert.ok(body.includes("52,597,522"));
  assert.ok(!body.includes("<html"));
  const index = await get("/llms.txt", blog);
  assert.match(index.headers.get("content-type"), /^text\/plain;/);
  assert.ok((await index.text()).includes("https://turret.capital/agent-brief.md"));
  const evidence = await get("/evidence/mainnet-2026-09-02.json", blog);
  assert.match(evidence.headers.get("content-type"), /^application\/json;/);
  assert.equal((await evidence.json()).markets.length, 10);
  const robot = await get("/robots.txt", blog);
  assert.match(robot.headers.get("content-type"), /^text\/plain;/);
  assert.ok((await robot.text()).includes("Allow: /"));
  const image = await get(imagePath, blog);
  assert.equal(image.headers.get("content-type"), "image/png");
  const bytes = Buffer.from(await image.arrayBuffer());
  assert.equal(hash(bytes), hash(readFileSync(`public${imagePath}`)));
  for (const path of ["/", blog ? sharePath : `/blog${sharePath}`]) {
    const html = await (await get(path, blog)).text();
    assert.match(html, /name="twitter:card" content="summary_large_image"/);
    assert.ok(html.includes(`property="og:image" content="https://turret.capital${imagePath}"`));
    assert.ok(html.includes("property=\"og:image:width\" content=\"1774\""));
    if (path !== "/") {
      assert.ok(html.includes(`rel="canonical" href="https://blog.turret.capital${sharePath}"`));
      assert.ok(html.includes("type=\"text/markdown\" href=\"https://turret.capital/agent-brief.md\""));
      assert.ok(html.includes("Read-only checks for your agent"));
    }
  }
}
const homepage = await (await get("/")).text();
// The protocol shell hydrates on the client; check the shipped page scripts for its existing player.
const scriptPaths = [...homepage.matchAll(/<script[^>]*src="([^"]+)"/g)].map((match) => match[1]);
const scripts = await Promise.all(scriptPaths.map(async (path) => (await get(path)).text()));
assert.ok(scripts.join("\n").includes("How borrowing works"), "Existing production video trigger remains in the page bundle");
const videoPath = "/videos/dockyard-how-borrowing-works-v1.mp4";
const video = await get(videoPath, false, { Range: "bytes=0-31" });
assert.equal((await video.arrayBuffer()).byteLength, 32);
assert.match(video.headers.get("content-range"), /^bytes 0-31\//);
console.log("PASS: both hosts, crawler metadata, canonical/Markdown links, text MIME types, dated evidence, exact card bytes, robots and existing video ranges.");
