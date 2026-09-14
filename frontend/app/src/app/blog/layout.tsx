import type { Metadata } from "next";
import type { ReactNode } from "react";
import { blogHref, MARKETS_ORIGIN } from "@/src/blog-config";
import { Logo } from "@/src/comps/Logo/Logo";
import { XLink } from "@/src/comps/AppLayout/XLink";
import { getBlogOrigin } from "@/src/blog";
import "./blog.css";

export const metadata: Metadata = {
  metadataBase: new URL(getBlogOrigin()),
  title: { default: "Blog | Turret", template: "%s | Turret" },
  description: "Notes on Stock Token borrowing and the design of Turret.",
  alternates: { types: { "application/rss+xml": "/feed.xml" } },
};

export default function BlogLayout({ children }: { children: ReactNode }) {
  return (
    <div className="blog-shell">
      <a className="blog-skip" href="#blog-main">Skip to content</a>
      <header className="blog-navigation blog-frame">
        <a href={MARKETS_ORIGIN} aria-label="Turret home" className="blog-brand"><Logo size={32} /></a>
        <nav aria-label="Primary">
          <a href={blogHref()} aria-current="true">Blog</a>
          <a href={MARKETS_ORIGIN}>Markets</a>
        </nav>
      </header>
      <main id="blog-main" className="blog-main blog-frame" tabIndex={-1}>{children}</main>
      <footer className="blog-footer blog-frame">
        <span>Turret · Independent Stock Token credit</span>
        <div><XLink /><a href="mailto:support@turret.capital">support@turret.capital</a><a href={blogHref()}>All articles</a><a href={blogHref("/feed.xml")}>RSS feed</a></div>
      </footer>
    </div>
  );
}
