import { escapeHtml, getBlogOrigin, getPosts } from "@/src/blog";

export const dynamic = "force-static";
export function GET() {
  const origin = getBlogOrigin();
  const urls = ["/", ...getPosts().map((post) => `/${post.slug}`)];
  return new Response(`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.map((url) => `<url><loc>${escapeHtml(new URL(url, origin).href)}</loc></url>`).join("")}</urlset>`, {
    headers: { "Content-Type": "application/xml; charset=utf-8" },
  });
}
