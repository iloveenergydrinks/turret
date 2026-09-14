import type { Metadata } from "next";
import Image from "next/image";
import { blogHref } from "@/src/blog-config";
import { notFound } from "next/navigation";
import { formatPostDate, getBlogOrigin, getPost, getPosts } from "@/src/blog";
import { SOCIAL_IMAGE } from "@/src/social-metadata";
import { AGENT_BRIEF_SLUG, AGENT_BRIEF_URL } from "@/src/agent-brief-config";

export const dynamicParams = false;
export function generateStaticParams() { return getPosts().map(({ slug }) => ({ slug })); }

type Props = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const post = getPost((await params).slug);
  if (!post) notFound();
  const shareImage = post.coverType === "artwork"
    ? { url: new URL(post.cover, getBlogOrigin()).href, alt: post.coverAlt }
    : SOCIAL_IMAGE;
  return {
    title: post.title, description: post.description,
    alternates: { canonical: `/${post.slug}`, types: {
      "application/rss+xml": "/feed.xml",
      ...(post.slug === AGENT_BRIEF_SLUG ? { "text/markdown": AGENT_BRIEF_URL } : {}),
    } },
    openGraph: {
      type: "article", title: post.title, description: post.description, url: `/${post.slug}`,
      publishedTime: post.date, authors: [post.author],
      images: [shareImage],
    },
    twitter: { card: "summary_large_image", title: post.title, description: post.description, images: [shareImage] },
  };
}

export default async function ArticlePage({ params }: Props) {
  const post = getPost((await params).slug);
  if (!post) notFound();
  const origin = getBlogOrigin();
  const structuredData = {
    "@context": "https://schema.org", "@type": "BlogPosting", headline: post.title,
    description: post.description, datePublished: post.date,
    author: { "@type": "Organization", name: post.author },
    publisher: { "@type": "Organization", name: "Turret" },
    image: new URL(post.cover, origin).href,
    mainEntityOfPage: new URL(`/${post.slug}`, origin).href,
  };
  return (
    <article className="blog-article">
      <a className="blog-back" href={blogHref()}>All articles</a>
      <header className="blog-article-heading">
        <h1>{post.title}</h1>
        <p className="blog-deck">{post.description}</p>
        <div className="blog-post-meta"><span>{post.author}</span><time dateTime={post.date}>{formatPostDate(post.date)}</time><span>{post.readingMinutes} min read</span></div>
      </header>
      <div className="blog-article-cover" data-cover-type={post.coverType}><Image src={post.cover} alt={post.coverAlt} fill priority sizes="(max-width: 1100px) 100vw, 1040px" /></div>
      <div className="blog-reading-layout">
        <aside className="blog-contents">
          <nav aria-label="In this article"><p>In this article</p><ol>{post.headings.map((heading) => <li key={heading.id}><a href={`#${heading.id}`}>{heading.text}</a></li>)}</ol></nav>
        </aside>
        <div className="blog-prose" dangerouslySetInnerHTML={{ __html: post.html }} />
      </div>
      <footer className="blog-article-end"><a href={blogHref()}>Back to all articles</a><a href={blogHref("/feed.xml")}>Follow via RSS</a></footer>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(structuredData).replace(/</g, "\\u003c") }} />
    </article>
  );
}
