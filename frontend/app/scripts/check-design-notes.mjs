import { readdir, readFile, writeFile, rename } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { hasLegacyBranding } from "./release-branding.mjs";

const marker = /\b(?:THESIS|OWN-WORLD|FIRST VIEWPORT):|FINISH:\s*unreviewed/;
const extensions = new Set([".html", ".txt", ".js", ".json", ".css", ".svg", ".map"]);

// Covers HTML as well as comments inside serialized Next/RSC string values.
// Leave the surrounding template/string intact so hydration data stays valid.
export function stripDesignNotes(text) {
  return text.replace(/(?:<|\\+u003c)!--[\s\S]*?--(?:>|\\+u003e)/gi, (comment) => marker.test(comment) ? "" : comment);
}

export async function checkDesignNotes(root, { write = false } = {}) {
  let checked = 0;
  const changed = [];
  const failures = [];
  async function visit(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = resolve(dir, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && extensions.has(extname(path))) {
        checked++;
        const original = await readFile(path, "utf8");
        const clean = write ? stripDesignNotes(original) : original;
        if (marker.test(clean) || hasLegacyBranding(clean)) failures.push(path);
        if (clean !== original) {
          // Replace the inode: release previews can be hard-linked to a baseline.
          await writeFile(`${path}.design-clean.tmp`, clean);
          await rename(`${path}.design-clean.tmp`, path);
          changed.push(path);
        }
      }
    }
  }
  await visit(resolve(root));
  if (failures.length) throw new Error(`Internal design notes or stale public branding found in release files:\n${failures.join("\n")}`);
  return { checked, changed };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = process.argv.slice(2).find((arg) => !arg.startsWith("--")) || fileURLToPath(new URL("../out", import.meta.url));
  const result = await checkDesignNotes(root, { write: process.argv.includes("--write") });
  console.log(`Design-note release check passed: ${result.checked} files checked, ${result.changed.length} cleaned.`);
}
