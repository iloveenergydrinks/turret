import { createRss, getBlogOrigin, getPosts } from "@/src/blog";

export const dynamic = "force-static";
export function GET() {
  return new Response(createRss(getPosts(), getBlogOrigin()), {
    headers: { "Content-Type": "application/rss+xml; charset=utf-8" },
  });
}
