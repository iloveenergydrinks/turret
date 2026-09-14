import assert from "node:assert/strict";
import { test } from "node:test";
import { legacyBlogSlugs, resolveBlogRequest } from "./blog-routing.mjs";

test("blog host serves the root and article paths from the static blog export", () => {
  assert.equal(resolveBlogRequest("/", "blog.turret.capital").pathname, "/blog");
  assert.equal(
    resolveBlogRequest("/introducing-turret/", "BLOG.TURRET.CAPITAL:443").pathname,
    "/blog/introducing-turret",
  );
  for (const file of ["feed.xml", "sitemap.xml", "robots.txt"]) {
    assert.equal(resolveBlogRequest(`/${file}`, "blog.turret.capital").pathname, `/blog/${file}`);
  }
});
test("assets remain reachable and old internal article paths redirect", () => {
  for (const pathname of ["/_next/static/app.js", "/blog/sea-glass-drift.webp", "/brand/turret-mark.svg"]) {
    assert.equal(resolveBlogRequest(pathname, "blog.turret.capital").pathname, pathname);
  }
  assert.equal(resolveBlogRequest("/blog", "blog.turret.capital").redirect, "/");
  assert.equal(
    resolveBlogRequest("/blog/introducing-turret", "blog.turret.capital").redirect,
    "/introducing-turret",
  );
});
test("the markets host and localhost keep their existing routes", () => {
  assert.deepEqual(resolveBlogRequest("/borrow/aapl", "turret.capital"), { pathname: "/borrow/aapl", isBlog: false });
  assert.deepEqual(resolveBlogRequest("/blog", "localhost:3000"), { pathname: "/blog", isBlog: false });
  assert.equal(resolveBlogRequest("/borrow/aapl", "blog.turret.capital").pathname, "/blog/__not_found__");
});
test("blog loads versioned production styles, scripts, and editorial fonts", () => {
  for (const pathname of [
    "/_next-slv-active-82c4e8cd41159a07/static/css/360b45b061597297.css",
    "/_next-slv-active-82c4e8cd41159a07/static/chunks/app/blog/%5Bslug%5D/page.js",
    "/fonts/turret-editorial/caslon-regular.woff2",
    "/turret-widget-integration-v1.css",
    "/turret-earn-art-v1.css",
  ]) {
    assert.equal(resolveBlogRequest(pathname, "blog.turret.capital").pathname, decodeURIComponent(pathname));
  }
  assert.equal(resolveBlogRequest("/_next-private/config.json", "blog.turret.capital").pathname, "/blog/__not_found__");
});
test("encoded Next chunk filenames resolve on both hosts", () => {
  for (const host of ["blog.turret.capital", "turret.capital"]) {
    assert.equal(
      resolveBlogRequest("/_next/static/chunks/app/blog/%5Bslug%5D/page.js", host).pathname,
      "/_next/static/chunks/app/blog/[slug]/page.js",
    );
    assert.equal(resolveBlogRequest("/_next/%invalid", host).badRequest, true);
    assert.equal(resolveBlogRequest("/_next/%00.js", host).badRequest, true);
  }
});
test("agent documents and evidence are readable on both public hosts", () => {
  for (const host of ["turret.capital", "blog.turret.capital"]) {
    for (const pathname of ["/llms.txt", "/agent-brief.md", "/evidence/mainnet-2026-09-02.json", "/brand/turret-social.png"]) {
      expectUnchanged(pathname, host);
    }
  }
  assert.equal(resolveBlogRequest("/evidence/private.json", "blog.turret.capital").pathname, "/blog/__not_found__");
});

function expectUnchanged(pathname, host) {
  assert.equal(resolveBlogRequest(pathname, host).pathname, pathname);
}

test("retired article URLs permanently resolve to Turret names without loops", () => {
  for (const [oldSlug, newSlug] of Object.entries(legacyBlogSlugs)) {
    for (const prefix of ["/", "/blog/"]) {
      for (const suffix of ["", "/", ".html", ".txt"]) {
        const destination = "/" + newSlug + (suffix === ".txt" ? ".txt" : "");
        const result = resolveBlogRequest(prefix + oldSlug + suffix, "blog.turret.capital");
        assert.equal(result.redirect, destination);
        const final = resolveBlogRequest(destination, "blog.turret.capital");
        assert.equal(final.redirect, undefined);
        assert.equal(final.pathname, "/blog" + destination);
      }
    }
    assert.equal(resolveBlogRequest("/blog/" + oldSlug, "turret.capital").redirect, "/blog/" + newSlug);
    assert.equal(resolveBlogRequest("/" + oldSlug, "turret.capital").redirect, undefined);
    assert.equal(resolveBlogRequest("/" + oldSlug + "-unknown", "blog.turret.capital").redirect, undefined);
  }
});
