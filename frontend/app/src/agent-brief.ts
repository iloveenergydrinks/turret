import matter from "gray-matter";
import { readFileSync } from "node:fs";
import path from "node:path";
import { AGENT_BRIEF_SLUG, AGENT_SHARE_URL } from "./agent-brief-config";
import { getPost } from "./blog";

// HTML and agent-facing Markdown come from one reviewed article.
export function getAgentBrief(): string {
  const post = getPost(AGENT_BRIEF_SLUG);
  if (!post) throw new Error("Agent brief must be a published article");
  const { content } = matter(readFileSync(path.join(process.cwd(), "content/blog", `${AGENT_BRIEF_SLUG}.md`), "utf8"));
  return `# ${post.title}\n\n${post.description}\n\nPublisher: ${post.author}\nPublished: ${post.date}\nHuman-readable version: ${AGENT_SHARE_URL}\n\n${content.trim()}\n`;
}
