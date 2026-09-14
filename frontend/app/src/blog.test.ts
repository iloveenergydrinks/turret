import { describe, expect, it } from "vitest";
import { createRss, formatPostDate, getBlogOrigin, getPost, getPosts, parsePost, renderMarkdown } from "./blog";
import { blogHref } from "./blog-config";

const source = `---
title: "A title & a test"
description: "A short description"
date: "2026-09-02"
author: "Turret"
category: "Protocol"
cover: "/blog/sea-glass-drift.webp"
coverAlt: "Sea glass"
draft: false
---
An introduction.

## One heading

A [source](https://docs.liquity.org/liquity-v1).

## One heading

A second section.
`;

describe("file-based blog", () => {
  it("preserves complete cover artwork while keeping background covers as the default", () => {
    expect(parsePost(source, "a-post").coverType).toBe("background");
    expect(parsePost(source.replace("draft: false", "coverType: artwork\ndraft: false"), "a-post").coverType).toBe("artwork");
    expect(() => parsePost(source.replace("draft: false", "coverType: invalid\ndraft: false"), "a-post")).toThrow("coverType");
  });
  it("parses metadata, reading time and unique heading anchors", () => {
    const post = parsePost(source, "a-post");
    expect(post.title).toBe("A title & a test");
    expect(post.readingMinutes).toBe(1);
    expect(post.headings.map(({ id }) => id)).toEqual(["one-heading", "one-heading-2"]);
    expect(post.html).toContain("href=\"https://docs.liquity.org/liquity-v1\"");
  });
  it("rejects malformed metadata, paths and duplicate page titles", () => {
    expect(() => parsePost(source, "../secret")).toThrow("slug");
    expect(() => parsePost(source.replace("title: \"A title & a test\"", "title:"), "a-post")).toThrow("title");
    expect(() => parsePost(source.replace("2026-09-02", "2026-02-30"), "a-post")).toThrow("date");
    expect(() => parsePost(source.replace("draft: false", "draft: \"false\""), "a-post")).toThrow("boolean");
    expect(() => parsePost(source.replace("/blog/sea-glass-drift.webp", "https://bad.test/a.png"), "a-post")).toThrow(
      "cover",
    );
    expect(() => renderMarkdown("# Duplicate title")).toThrow("metadata");
  });
  it("escapes raw HTML and rejects unsafe link and image protocols", () => {
    const { html } = renderMarkdown(
      "<script>alert(1)</script>\n\n[x](javascript:alert%281%29) ![x](data:image/svg+xml,bad)\n\n[x](jav&#x61;script:alert%281%29)\n\n[x](//evil.test)",
    );
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("href=");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;script&gt;");
  });
  it("keeps emphasis and supported local links and images", () => {
    const { html } = renderMarkdown("**Debt** and *collateral*. [Section](#risk). ![Mint](/blog/sea-glass-drift.webp)");
    expect(html).toContain("<strong>Debt</strong>");
    expect(html).toContain("href=\"#risk\"");
    expect(html).toContain("loading=\"lazy\"");
  });
  it("loads the inaugural article and does not resolve unknown slugs", () => {
    const posts = getPosts(new Date("2026-09-03"));
    expect(posts.some(({ slug }) => slug === "introducing-turret")).toBe(true);
    expect(posts.every(({ draft }) => !draft)).toBe(true);
    expect(getPosts(new Date("2000-01-01"))).toEqual([]);
    expect(getPost("../../package")).toBeUndefined();
  });
  it("uses the confirmed subdomain and formats dates in UTC", () => {
    expect(getBlogOrigin()).toBe("https://blog.turret.capital");
    expect(getBlogOrigin("https://blog.turret.capital/")).toBe("https://blog.turret.capital");
    expect(() => getBlogOrigin("https://user:password@blog.turret.capital")).toThrow();
    expect(() => getBlogOrigin("https://blog.turret.capital/path")).toThrow();
    expect(() => getBlogOrigin("javascript:alert(1)")).toThrow();
    expect(formatPostDate("2026-09-02")).toBe("September 2, 2026");
    expect(blogHref("/introducing-turret", "https://blog.turret.capital/")).toBe(
      "https://blog.turret.capital/introducing-turret",
    );
    expect(blogHref("/feed.xml", "https://blog.turret.capital/")).toBe("https://blog.turret.capital/feed.xml");
  });
  it("escapes RSS and links directly to the public article path", () => {
    const feed = createRss([parsePost(source, "a-post")], getBlogOrigin());
    expect(feed).toContain("A title &amp; a test");
    expect(feed).toContain("https://blog.turret.capital/a-post");
    expect(feed).toContain("https://blog.turret.capital/feed.xml");
    expect(feed).not.toContain("/blog/a-post");
    expect(feed).toContain("Wed, 02 Sep 2026 00:00:00 GMT");
  });
});
