import matter from "gray-matter";
import { Marked } from "marked";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { BLOG_ORIGIN } from "./blog-config";

export type BlogHeading = { id: string; text: string };
export type BlogPost = {
  slug: string;
  title: string;
  description: string;
  date: string;
  author: string;
  category: string;
  cover: string;
  coverAlt: string;
  coverType: "background" | "artwork";
  draft: boolean;
  readingMinutes: number;
  html: string;
  headings: BlogHeading[];
};

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) =>
    ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      "\"": "&quot;",
      "'": "&#39;",
    })[character]!);
}

function safeUrl(value: string): boolean {
  return /^(https?:\/\/|mailto:|\/(?!\/)|#)/i.test(value)
    && !Array.from(value).some((character) => character.charCodeAt(0) <= 32 || character === "\\");
}

export function renderMarkdown(content: string): { html: string; headings: BlogHeading[] } {
  const headings: BlogHeading[] = [];
  const usedIds = new Set<string>();
  const markdown = new Marked({
    renderer: {
      // Posts are repository-owned Markdown, not an executable HTML/MDX input.
      html({ text }) {
        return escapeHtml(text);
      },
      heading({ text, depth, tokens }) {
        if (depth === 1) throw new Error("Use post metadata for the title and ## for article headings.");
        const label = text.replace(/[*_`]/g, "");
        const base = label.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "") || "section";
        let id = base;
        for (let suffix = 2; usedIds.has(id); suffix++) id = `${base}-${suffix}`;
        usedIds.add(id);
        if (depth === 2) headings.push({ id, text: label });
        return `<h${depth} id="${escapeHtml(id)}">${this.parser.parseInline(tokens)}</h${depth}>\n`;
      },
      link({ href, title, tokens }) {
        const label = this.parser.parseInline(tokens);
        if (!safeUrl(href)) return label;
        return `<a href="${escapeHtml(href)}"${title ? ` title="${escapeHtml(title)}"` : ""}>${label}</a>`;
      },
      image({ href, text }) {
        if (!safeUrl(href) || /^(mailto:|#)/i.test(href)) return escapeHtml(text);
        return `<img src="${escapeHtml(href)}" alt="${escapeHtml(text)}" loading="lazy" decoding="async" />`;
      },
    },
  });
  return { html: markdown.parse(content, { async: false }), headings };
}

export function parsePost(source: string, slug: string): BlogPost {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) throw new Error(`Invalid blog slug: ${slug}`);
  const { data, content } = matter(source);
  function field(name: string): string {
    if (typeof data[name] !== "string" || !data[name].trim()) throw new Error(`${slug}: missing ${name}`);
    return data[name].trim();
  }
  const date = field("date");
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date))
    || new Date(date).toISOString().slice(0, 10) !== date
  ) throw new Error(`${slug}: invalid date`);
  if (data.draft !== undefined && typeof data.draft !== "boolean") throw new Error(`${slug}: draft must be boolean`);
  const cover = field("cover");
  const coverType = data.coverType ?? "background";
  if (coverType !== "background" && coverType !== "artwork") throw new Error(`${slug}: invalid coverType`);
  if (!/^\/blog\/[a-z0-9-]+\.(webp|png|jpg)$/.test(cover)) throw new Error(`${slug}: invalid local cover`);
  if (!content.trim()) throw new Error(`${slug}: empty article`);
  return {
    slug,
    date,
    cover,
    coverType,
    title: field("title"),
    description: field("description"),
    author: field("author"),
    category: field("category"),
    coverAlt: field("coverAlt"),
    draft: data.draft === true,
    readingMinutes: Math.max(1, Math.ceil(content.trim().split(/\s+/).length / 220)),
    ...renderMarkdown(content),
  };
}

export function getPosts(now = new Date()): BlogPost[] {
  const directory = path.join(process.cwd(), "content/blog");
  return readdirSync(directory)
    .filter((file) => file.endsWith(".md"))
    .map((file) => parsePost(readFileSync(path.join(directory, file), "utf8"), file.slice(0, -3)))
    .filter((post) => !post.draft && Date.parse(post.date) <= now.getTime())
    .map((post) => {
      if (!existsSync(path.join(process.cwd(), "public", post.cover))) throw new Error(`${post.slug}: missing cover`);
      return post;
    })
    .sort((a, b) => b.date.localeCompare(a.date) || a.slug.localeCompare(b.slug));
}

export function getPost(slug: string): BlogPost | undefined {
  return getPosts().find((post) => post.slug === slug);
}

export function getBlogOrigin(value = BLOG_ORIGIN): string {
  const url = new URL(value);
  if (
    !/^https?:$/.test(url.protocol) || url.username || url.password || url.pathname !== "/" || url.search || url.hash
  ) {
    throw new Error("NEXT_PUBLIC_BLOG_URL must be an http(s) origin without a path, credentials, query or fragment.");
  }
  return url.origin;
}

export function formatPostDate(date: string): string {
  return new Intl.DateTimeFormat("en", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" })
    .format(new Date(date));
}

export function createRss(posts: BlogPost[], origin: string): string {
  const absolute = (pathname: string) => escapeHtml(new URL(pathname, origin).href);
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom"><channel>
<title>Turret blog</title><link>${absolute("/")}</link>
<description>Notes on Stock Token borrowing and the design of Turret.</description><language>en</language>
<atom:link href="${absolute("/feed.xml")}" rel="self" type="application/rss+xml" />
${
    posts.map((post) =>
      `<item><title>${escapeHtml(post.title)}</title>
<link>${absolute(`/${post.slug}`)}</link><guid isPermaLink="true">${absolute(`/${post.slug}`)}</guid>
<description>${escapeHtml(post.description)}</description><category>${escapeHtml(post.category)}</category>
<pubDate>${new Date(post.date).toUTCString()}</pubDate></item>`
    ).join("\n")
  }
</channel></rss>`;
}
