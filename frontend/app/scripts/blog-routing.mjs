export const legacyBlogSlugs = Object.freeze({
  "dock-token-and-trading-fees": "turret-token-and-trading-fees",
  "bootstrapping-dockyard": "bootstrapping-turret",
  "introducing-dockyard": "introducing-turret",
  "understand-dockyard": "understand-turret",
});

export function resolveBlogRequest(pathname, host, blogHostname = "blog.turret.capital") {
  const isBlog = (host || "").split(":")[0].toLowerCase() === blogHostname.toLowerCase();
  try {
    pathname = decodeURIComponent(pathname);
    if (pathname.includes("\0")) throw new URIError("Invalid path");
  } catch {
    return { pathname, isBlog, badRequest: true };
  }
  const article = pathname.match(/^\/(blog\/)?([a-z0-9-]+)(?:\.(html|txt))?\/?$/);
  const replacement = article && Object.hasOwn(legacyBlogSlugs, article[2]) ? legacyBlogSlugs[article[2]] : null;
  if (replacement && (isBlog || article[1])) {
    const prefix = isBlog ? "/" : "/blog/";
    return { pathname, isBlog, redirect: prefix + replacement + (article[3] === "txt" ? ".txt" : "") };
  }
  if (!isBlog) return { pathname, isBlog };
  if (pathname === "/llms.txt" || pathname === "/agent-brief.md" || pathname === "/evidence/mainnet-2026-09-02.json") {
    return { pathname, isBlog };
  }
  if (pathname === "/blog" || pathname === "/blog/") return { pathname: "/", isBlog, redirect: "/" };
  if (/^\/blog\/[a-z0-9-]+\/?$/.test(pathname)) {
    return { pathname, isBlog, redirect: pathname.slice(5).replace(/\/$/, "") };
  }
  if (pathname === "/") return { pathname: "/blog", isBlog };
  if (pathname === "/feed.xml" || pathname === "/sitemap.xml" || pathname === "/robots.txt") {
    return { pathname: `/blog${pathname}`, isBlog };
  }
  if (/^\/[a-z0-9-]+\.txt$/.test(pathname)) return { pathname: `/blog${pathname}`, isBlog };
  if (/^\/[a-z0-9-]+\/?$/.test(pathname)) return { pathname: `/blog${pathname.replace(/\/$/, "")}`, isBlog };
  // Next chunks and approved public assets retain their exported paths.
  if (
    pathname.startsWith("/_next/")
    || /^\/_next-[a-z0-9-]+\/static\//.test(pathname)
    || /^\/fonts\/[a-z0-9-]+\/[a-z0-9-]+\.woff2$/.test(pathname)
    || /^\/turret-[a-z0-9-]+\.css$/.test(pathname)
    || /^\/(?:blog|brand)\/[^/]+\.(?:webp|png|jpg|svg|ico)$/.test(pathname)
  ) {
    return { pathname, isBlog };
  }
  return { pathname: "/blog/__not_found__", isBlog };
}
