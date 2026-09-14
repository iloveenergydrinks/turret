export const BLOG_ORIGIN = process.env.NEXT_PUBLIC_BLOG_URL || "https://blog.turret.capital";
export const MARKETS_ORIGIN = "https://turret.capital";

// The static host maps public subdomain paths to the exported /blog routes.
// Ordinary anchors keep navigation independent of Next's internal route names.
export function blogHref(pathname = "/", origin = BLOG_ORIGIN): string {
  return process.env.NODE_ENV === "development"
    ? `/blog${pathname === "/" ? "" : pathname}`
    : new URL(pathname, origin).href;
}
