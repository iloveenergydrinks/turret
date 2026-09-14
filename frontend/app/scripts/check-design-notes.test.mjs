import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { checkDesignNotes, stripDesignNotes } from "./check-design-notes.mjs";
import { rewriteLegacyBranding } from "./release-branding.mjs";

test("removes internal HTML comments without touching hydration markers or page content", () => {
  const input = '<body><!--THESIS: Internal brief\nOWN-WORLD: Warm white--><!--$--><main>Borrow USDG</main><!--/$--></body>';
  const expected = '<body><!--$--><main>Borrow USDG</main><!--/$--></body>';
  assert.equal(stripDesignNotes(input), expected);
  assert.equal(stripDesignNotes(expected), expected);
});

test("updates public links and copy while preserving signature text and API identities", () => {
  const input = 'https://blog.dockyard.finance/post This address does not point to a Dockyard page. https://dockyard-stock-risk-production.up.railway.app requests Dockyard borrower alert access. DockyardBorrowIntent';
  assert.equal(rewriteLegacyBranding(input), 'https://blog.turret.capital/post This address does not point to a Turret page. https://dockyard-stock-risk-production.up.railway.app requests Dockyard borrower alert access. DockyardBorrowIntent');
});

test("release gate rejects stale links in navigation data", async () => {
  const root = await mkdtemp(join(tmpdir(), "turret-old-brand-test-"));
  try {
    const file = join(root, "earn.txt");
    await writeFile(file, JSON.stringify({ href: "https://blog.dockyard.finance/" }));
    await assert.rejects(checkDesignNotes(root), /stale public branding/);
    await writeFile(file, rewriteLegacyBranding(await readFile(file, "utf8")));
    assert.equal((await checkDesignNotes(root)).checked, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("preserves valid serialized hydration data while emptying the internal comment", () => {
  const data = { __html: '<!--\nTHESIS: Internal brief\nFINISH: unreviewed-->', amount: "300", address: "0x123" };
  const encoded = JSON.stringify(JSON.stringify(data));
  const clean = JSON.parse(JSON.parse(stripDesignNotes(encoded)));
  assert.deepEqual(clean, { ...data, __html: "" });
  const nextScript = encoded.replaceAll("<", "\\u003c").replaceAll(">", "\\u003e");
  assert.deepEqual(JSON.parse(JSON.parse(stripDesignNotes(nextScript))), { ...data, __html: "" });
});

test("release gate rejects notes, cleanup removes them, and the clean release passes", async () => {
  const root = await mkdtemp(join(tmpdir(), "turret-design-notes-test-"));
  try {
    const file = join(root, "borrow.html");
    await writeFile(file, '<body><!-- THESIS: private brief --><main>Borrow</main></body>');
    await assert.rejects(checkDesignNotes(root), /Internal design notes/);
    assert.equal((await checkDesignNotes(root, { write: true })).changed.length, 1);
    assert.equal(await readFile(file, "utf8"), '<body><main>Borrow</main></body>');
    assert.equal((await checkDesignNotes(root)).checked, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});
