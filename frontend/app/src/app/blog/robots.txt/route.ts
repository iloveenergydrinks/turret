import { getBlogOrigin } from "@/src/blog";

export const dynamic = "force-static";
export function GET() {
  return new Response(`User-agent: *\nAllow: /\nSitemap: ${getBlogOrigin()}/sitemap.xml\n`, {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
