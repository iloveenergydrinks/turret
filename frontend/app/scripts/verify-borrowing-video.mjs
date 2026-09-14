import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const app = fileURLToPath(new URL("../", import.meta.url));
const player = await readFile(resolve(app, "src/comps/HowBorrowingWorks/HowBorrowingWorks.tsx"), "utf8");
const basenames = [...player.matchAll(/basename="([\w.-]+)"/g)].map(match => match[1]);
assert.equal(basenames.length, 2, "Expected pool and P2P borrowing video players");
const assets = basenames.flatMap(name => ["mp4", "jpg", "vtt"].map(ext => `/videos/${name}.${ext}`));
const origin = process.argv.find((arg) => /^https?:\/\//.test(arg));
const directory = process.argv[2] && !origin ? resolve(process.argv[2]) : resolve(app, "out");
for (const path of assets) {
  const extension = path.split(".").at(-1);
  let bytes;
  if (origin) {
    const response = await fetch(new URL(path, origin), {
      redirect: "manual",
      headers: extension === "mp4" ? { Range: "bytes=0-31" } : {},
      signal: AbortSignal.timeout(15000),
    });
    assert.equal(response.status, extension === "mp4" ? 206 : 200, `${path}: asset must be served directly, without a homepage redirect`);
    assert.ok(response.headers.get("content-type")?.startsWith({ mp4: "video/mp4", jpg: "image/jpeg", vtt: "text/vtt" }[extension]), `${path}: wrong MIME type`);
    if (extension === "mp4") assert.match(response.headers.get("content-range"), /^bytes 0-31\/\d+$/);
    bytes = Buffer.from(await response.arrayBuffer());
    if (extension === "mp4") assert.equal(bytes.length, 32);
  } else {
    bytes = await readFile(resolve(directory, `.${path}`));
  }
  assert.ok(bytes.length > 0, `${path}: empty asset`);
  if (extension === "mp4") assert.equal(bytes.toString("ascii", 4, 8), "ftyp", `${path}: not an MP4`);
  if (extension === "jpg") assert.equal(bytes.readUInt16BE(0), 0xffd8, `${path}: not a JPEG`);
  if (extension === "vtt") assert.ok(bytes.toString("utf8").startsWith("WEBVTT"), `${path}: not WebVTT`);
  console.log(`PASS ${path}`);
}
