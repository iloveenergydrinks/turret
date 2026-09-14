import type { Metadata } from "next";
import Image from "next/image";
import { blogHref } from "@/src/blog-config";
import { formatPostDate, getPosts } from "@/src/blog";
import { SOCIAL_IMAGE } from "@/src/social-metadata";

export const metadata: Metadata = {
  alternates: { canonical: "/", types: { "application/rss+xml": "/feed.xml" } },
  openGraph: {
    title: "Turret blog", description: "Notes on Stock Token borrowing and the design of Turret.",
    type: "website", url: "/", images: [SOCIAL_IMAGE],
  },
  twitter: { card: "summary_large_image", title: "Turret blog", description: "Notes on Stock Token borrowing and the design of Turret.", images: [SOCIAL_IMAGE] },
};

export default function BlogIndex() {
  const [featured, ...rest] = getPosts();
  return (
    <>
      <header className="blog-index-heading">
        <h1>From Turret.</h1>
        <p>Notes on borrowing, Stock Tokens, and the decisions behind the protocol.</p>
      </header>
      {featured ? (
        <article className="blog-feature">
          <a className="blog-cover-link" data-cover-type={featured.coverType} href={blogHref(`/${featured.slug}`)} aria-label={`Read ${featured.title}`}>
            <Image src={featured.cover} alt={featured.coverAlt} fill priority sizes="(max-width: 760px) 100vw, 56vw" />
            {featured.coverType === "background" && <span className="blog-cover-title" aria-hidden="true">Stock Tokens.<br />Dollar liquidity.</span>}
          </a>
          <div className="blog-feature-copy">
            <h2><a href={blogHref(`/${featured.slug}`)}>{featured.title}</a></h2>
            <div className="blog-post-meta"><span>{featured.category}</span><span>{featured.readingMinutes} min read</span></div>
            <p>{featured.description}</p>
            <time dateTime={featured.date}>{formatPostDate(featured.date)}</time>
            <a className="blog-read-link" href={blogHref(`/${featured.slug}`)}>Read the article</a>
          </div>
        </article>
      ) : <p className="blog-empty">Our first article is on its way.</p>}
      {rest.length > 0 && (
        <section className="blog-archive" aria-labelledby="blog-archive-title">
          <h2 id="blog-archive-title">More from Turret</h2>
          {rest.map((post) => (
            <article className="blog-archive-row" key={post.slug}>
              <time dateTime={post.date}>{formatPostDate(post.date)}</time>
              <div><h3><a href={blogHref(`/${post.slug}`)}>{post.title}</a></h3><p>{post.description}</p></div>
              <span>{post.readingMinutes} min read</span>
            </article>
          ))}
        </section>
      )}
      <div className="blog-follow"><p>Follow new articles in your own reader.</p><a href={blogHref("/feed.xml")}>Subscribe via RSS</a></div>
    </>
  );
}
