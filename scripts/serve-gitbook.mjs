#!/usr/bin/env node
// Documentation site backed by the GitBook source, with stable public page URLs.
import { createServer } from 'node:http';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const book = realpathSync(resolve(root, 'docs/gitbook'));
const require = createRequire(import.meta.url);
let Marked;
try {
  ({ Marked } = require('marked'));
} catch (error) {
  if (error.code !== 'MODULE_NOT_FOUND') throw error;
  ({ Marked } = createRequire(resolve(root, 'frontend/app/package.json'))('marked'));
}
const production = process.env.NODE_ENV === 'production';
const port = Number(process.env.PORT || process.env.DOCS_PORT || 4175);
const host = process.env.DOCS_HOST || (production || process.env.PORT ? '0.0.0.0' : '127.0.0.1');
const origin = (process.env.DOCS_SITE_URL || 'https://docs.turret.capital').replace(/\/$/, '');
const escape = value => String(value).replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[character]);

function navigation() {
  const sections = [];
  for (const line of readFileSync(resolve(book, 'SUMMARY.md'), 'utf8').split('\n')) {
    const section = line.match(/^## (.+)$/);
    const entry = line.match(/^\* \[([^\]]+)\]\(([^)]+)\)$/);
    if (section) sections.push({ title: section[1], pages: [] });
    if (entry) sections.at(-1).pages.push({ title: entry[1], path: entry[2] });
  }
  return sections;
}

function routeForSource(source) {
  return `/${source.replace(/(^|\/)README\.md$/, '').replace(/\.md$/, '')}`.replace(/\/$/, '') || '/';
}

function pageLink(href, current) {
  if (!href || /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(href)) return href;
  const url = new URL(href, `${origin}/${current}`);
  const pathname = decodeURIComponent(url.pathname).slice(1);
  const route = pathname.endsWith('.md') ? routeForSource(pathname) : url.pathname;
  return `${route}${url.search}${url.hash}`;
}

function render(source, current) {
  const sections = navigation();
  const pages = sections.flatMap(section => section.pages);
  const index = pages.findIndex(page => page.path === current);
  const title = source.match(/^# (.+)$/m)?.[1] || 'Turret documentation';
  const description = source.match(/^description:\s*"(.*)"\s*$/m)?.[1]?.replace(/\\"/g, '"') || 'Turret protocol and platform documentation.';
  const headings = [];
  const ids = new Map();
  const markdown = new Marked({ gfm: true, renderer: {
    link({ href, title, tokens }) {
      return `<a href="${escape(pageLink(href, current))}"${title ? ` title="${escape(title)}"` : ''}>${this.parser.parseInline(tokens)}</a>`;
    },
    image({ href, title, text }) {
      return `<img src="${escape(pageLink(href, current))}" alt="${escape(text)}"${title ? ` title="${escape(title)}"` : ''} loading="lazy">`;
    },
    heading({ tokens, depth }) {
      const html = this.parser.parseInline(tokens);
      const text = html.replace(/<[^>]*>/g, '');
      const slug = text.toLowerCase().replace(/&[^;]+;/g, '').replace(/[^\p{L}\p{N}\s-]/gu, '').trim().replace(/\s+/g, '-');
      const count = ids.get(slug) || 0;
      ids.set(slug, count + 1);
      const id = count ? `${slug}-${count}` : slug;
      if (depth === 2 || depth === 3) headings.push({ id, text, depth });
      return `<h${depth} id="${escape(id)}">${html}</h${depth}>\n`;
    },
    code({ text, lang }) {
      return lang === 'mermaid'
        ? `<pre class="mermaid">${escape(text)}</pre>`
        : `<pre><code>${escape(text)}</code></pre>`;
    },
  } });
  const body = markdown.parse(source.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, ''))
    .replace(/<table>/g, '<div class="table-scroll" tabindex="0"><table>').replace(/<\/table>/g, '</table></div>');
  const chapter = sections.find(section => section.pages.some(page => page.path === current));
  const pagination = (page, label) => page
    ? `<a href="${escape(routeForSource(page.path))}"><small>${label}</small>${escape(page.title)} <span aria-hidden="true">→</span></a>`
    : '<span></span>';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escape(title)} · Turret docs</title><link rel="icon" href="data:,">
<meta name="description" content="${escape(description)}"><link rel="canonical" href="${escape(origin + routeForSource(current))}">
<style>
:root{color-scheme:light;--ink:#202a2a;--muted:#667473;--line:#e4e9e7;--green:#126951;--wash:#f3f7f5}
*{box-sizing:border-box}html{scroll-behavior:smooth;scroll-padding-top:90px}body{margin:0;color:var(--ink);background:#fff;font:15px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}a{color:var(--green);text-decoration:none}a:hover{text-decoration:underline}a:focus-visible,button:focus-visible,input:focus-visible{outline:2px solid var(--green);outline-offset:3px}
header{height:68px;position:fixed;inset:0 0 auto;z-index:5;display:flex;align-items:center;gap:18px;padding:0 30px;border-bottom:1px solid var(--line);background:#fff}header .brand{font-size:22px;font-weight:750;letter-spacing:-1px;color:var(--ink)}header .divider{height:22px;border-left:1px solid var(--line)}header .label{color:var(--muted);font-size:14px}header .preview{margin-left:auto;font-size:12px;padding:3px 10px;border:1px solid var(--line);border-radius:20px;color:var(--muted)}button{font:inherit;cursor:pointer}.menu{display:none;border:1px solid var(--line);background:#fff;border-radius:5px;padding:3px 9px}
.skip{position:fixed;left:12px;top:-60px;z-index:20;background:#fff;padding:8px}.skip:focus{top:8px}
.sidebar{position:fixed;top:68px;bottom:0;left:0;width:282px;padding:26px 18px 40px 24px;overflow-y:auto;border-right:1px solid var(--line);background:#fcfdfc}.search{display:block;font-size:12px;color:var(--muted)}input{width:100%;font:inherit;font-size:13px;padding:9px 11px;margin:5px 0 16px;border:1px solid #d5dfda;border-radius:6px;background:#fff;color:var(--ink)}.nav-section h2{font-size:11px;letter-spacing:.065em;text-transform:uppercase;margin:24px 9px 8px;color:var(--muted)}.nav-section a{display:block;padding:6px 10px;margin:2px 0;font-size:13px;line-height:1.5;border-radius:5px;color:#4c5c59}.nav-section a:hover{background:var(--wash);text-decoration:none}.nav-section a[aria-current]{background:#e8f1ec;color:#0b654b;font-weight:600}.empty{font-size:13px;color:var(--muted)}[hidden]{display:none!important}
.layout{margin:68px 0 0 282px;display:grid;grid-template-columns:minmax(0,850px) 210px;justify-content:center;gap:48px;padding:46px 44px 70px}main{min-width:0}.eyebrow{font-size:12px;font-weight:600;color:var(--green);margin-bottom:12px}article h1{font-size:38px;letter-spacing:-1.4px;line-height:1.18;margin:0 0 27px;font-weight:700}article h2{font-size:24px;letter-spacing:-.5px;line-height:1.3;margin:42px 0 16px}article h3{font-size:18px;margin:30px 0 12px}article p{margin:0 0 19px}article li{margin:7px 0}article a{text-decoration:underline;text-underline-offset:3px}article strong{font-weight:650}article code{font:12px/1.65 ui-monospace,SFMono-Regular,Menlo,monospace;padding:2px 4px;background:var(--wash);border-radius:3px;overflow-wrap:anywhere}article pre{padding:18px 20px;background:#f5f7f6;border:1px solid var(--line);border-radius:8px;overflow:auto;font-size:12px;line-height:1.65}article pre code{padding:0;background:none;overflow-wrap:normal}article blockquote{border-left:3px solid #9fbbae;margin:24px 0;padding:4px 20px;color:var(--muted)}article img,article svg{max-width:100%}.table-scroll{overflow:auto;margin:24px 0;border:1px solid var(--line);border-radius:7px}table{border-collapse:collapse;width:100%;font-size:13px;text-align:left}th{background:var(--wash);font-weight:600}td,th{padding:12px 14px;vertical-align:top;border-bottom:1px solid var(--line);min-width:105px}tr:last-child td{border-bottom:0}.mermaid{background:#fff;text-align:center;white-space:pre-wrap}.mermaid svg{height:auto}.diagram-note{font-size:12px;color:var(--muted)}
.toc{position:sticky;top:104px;align-self:start;max-height:calc(100vh - 140px);overflow:auto;border-left:1px solid var(--line);padding-left:18px;font-size:12px}.toc p{font-weight:600;margin:0 0 12px}.toc a{display:block;margin:9px 0;line-height:1.5;color:var(--muted)}.toc a.sub{padding-left:10px}.pagination{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-top:48px;padding-top:24px;border-top:1px solid var(--line)}.pagination a{border:1px solid var(--line);border-radius:7px;padding:14px 17px;font-size:14px}.pagination small{display:block;font-size:11px;color:var(--muted);margin-bottom:4px}.pagination span{float:right}footer{margin-top:26px;font-size:12px;color:var(--muted)}
@media(min-width:1600px){.layout{padding-top:56px;gap:65px}}@media(max-width:1200px){.toc{display:none}.layout{grid-template-columns:minmax(0,850px);padding:38px 35px}}@media(max-width:760px){header{padding:0 18px;height:60px;gap:12px}header .label{font-size:12px}header .preview{display:none}.menu{display:block}.sidebar{display:none;top:60px;width:min(320px,90vw);z-index:4;box-shadow:12px 0 30px #0001}.sidebar.open{display:block}.layout{margin:60px 0 0;padding:30px 20px 50px}article h1{font-size:31px}article h2{font-size:22px}.pagination{grid-template-columns:1fr}body.nav-open{overflow:hidden}}
</style></head><body>
<a class="skip" href="#content">Skip to content</a>
<header><button class="menu" aria-expanded="false" aria-controls="chapters" aria-label="Toggle chapters">☰</button><a class="brand" href="/">turret</a><span class="divider"></span><span class="label">Documentation</span>${production ? '' : '<span class="preview">Local preview</span>'}</header>
<nav class="sidebar" id="chapters" aria-label="Chapters"><label class="search" for="filter">Find a chapter</label><input id="filter" type="search" placeholder="Filter chapters…" autocomplete="off">
${sections.map(section => `<section class="nav-section"><h2>${escape(section.title)}</h2>${section.pages.map(page => `<a href="${escape(routeForSource(page.path))}"${page.path === current ? ' aria-current="page"' : ''}>${escape(page.title)}</a>`).join('')}</section>`).join('')}
<p class="empty" hidden>No chapters found.</p></nav>
<div class="layout"><main id="content"><div class="eyebrow">${escape(chapter?.title || 'Documentation')}</div><article>${body}</article>
<nav class="pagination" aria-label="Adjacent pages">${pagination(pages[index - 1], 'Previous')}${pagination(pages[index + 1], 'Next')}</nav>
<footer>Turret documentation${production ? '' : ' · Local source preview'}</footer></main>
<aside class="toc" aria-label="On this page"><p>On this page</p>${headings.map(heading => `<a class="${heading.depth === 3 ? 'sub' : ''}" href="#${escape(heading.id)}">${heading.text}</a>`).join('')}</aside></div>
<script>
const filter = document.querySelector('#filter');
filter.addEventListener('input', () => {
  const query = filter.value.trim().toLowerCase();
  let count = 0;
  document.querySelectorAll('.nav-section').forEach(section => {
    let visible = 0;
    section.querySelectorAll('a').forEach(link => {
      link.hidden = !link.textContent.toLowerCase().includes(query);
      if (!link.hidden) visible++;
    });
    section.hidden = !visible;
    count += visible;
  });
  document.querySelector('.empty').hidden = count > 0;
});
document.querySelector('.menu').addEventListener('click', event => {
  const open = document.querySelector('.sidebar').classList.toggle('open');
  document.body.classList.toggle('nav-open', open);
  event.currentTarget.setAttribute('aria-expanded', String(open));
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') {
    document.querySelector('.sidebar').classList.remove('open');
    document.body.classList.remove('nav-open');
    document.querySelector('.menu').setAttribute('aria-expanded', 'false');
  }
});
</script>
${source.includes('```mermaid') ? `<script type="module">
try {
  const { default: mermaid } = await import('https://cdn.jsdelivr.net/npm/mermaid@11.12.0/dist/mermaid.esm.min.mjs');
  mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'neutral', fontFamily: '-apple-system, sans-serif' });
  await mermaid.run({ querySelector: '.mermaid' });
} catch (error) {
  document.querySelectorAll('.mermaid').forEach(block => {
    const note = document.createElement('p');
    note.className = 'diagram-note';
    note.textContent = 'Diagram source shown. Diagram rendering needs access to the Mermaid CDN.';
    block.before(note);
  });
  console.warn('Diagram renderer unavailable:', error);
}
</script>` : ''}
</body></html>`;
}

const server = createServer((request, response) => {
  const send = (status, type, body) => {
    response.writeHead(status, {
      'Content-Type': type,
      'Cache-Control': production && status === 200 ? 'public, max-age=60' : 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
    });
    response.end(request.method === 'HEAD' ? undefined : body);
  };
  if (!['GET', 'HEAD'].includes(request.method)) return send(405, 'text/plain', 'Method not allowed');
  try {
    const url = new URL(request.url, 'http://127.0.0.1');
    const pathname = decodeURIComponent(url.pathname);
    if (pathname.includes('\0') || pathname.includes('\\')) return send(400, 'text/plain', 'Invalid URL');
    const pages = navigation().flatMap(section => section.pages);
    const routes = new Map(pages.map(page => [routeForSource(page.path), page.path]));
    const cleanPath = pathname.replace(/\/+$/, '') || '/';
    const source = cleanPath.endsWith('.md') ? cleanPath.slice(1) : routes.get(cleanPath);
    const canonical = source && pages.some(page => page.path === source) ? routeForSource(source) : null;
    if (canonical && pathname !== canonical) {
      response.writeHead(308, { Location: `${canonical}${url.search}` });
      return response.end();
    }
    if (canonical) {
      return send(200, 'text/html; charset=utf-8', render(readFileSync(resolve(book, source), 'utf8'), source));
    }
    if (pathname === '/robots.txt') return send(200, 'text/plain; charset=utf-8', `User-agent: *\nAllow: /\nSitemap: ${origin}/sitemap.xml\n`);
    if (pathname === '/sitemap.xml') return send(200, 'application/xml; charset=utf-8', `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${pages.map(page => `<url><loc>${escape(origin + routeForSource(page.path))}</loc></url>`).join('')}</urlset>`);
    if (!pathname.startsWith('/.gitbook/assets/')) return send(404, 'text/plain', 'Page not found');
    const path = realpathSync(resolve(book, `.${pathname}`));
    if (!path.startsWith(resolve(book, '.gitbook/assets') + sep) || !statSync(path).isFile()) return send(404, 'text/plain', 'Page not found');
    const extension = extname(path);
    const types = { '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.pdf': 'application/pdf' };
    if (!types[extension]) return send(404, 'text/plain', 'Page not found');
    send(200, types[extension], readFileSync(path));
  } catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes(error.code)) return send(404, 'text/plain', 'Page not found');
    if (error instanceof URIError) return send(400, 'text/plain', 'Invalid URL');
    console.error(error);
    send(500, 'text/plain', 'Could not render this documentation page');
  }
});
server.on('error', error => { console.error(error.message); process.exitCode = 1; });
server.listen(port, host, () => {
  console.log(`Turret documentation listening on http://${host}:${port}`);
  if (!production) console.log('Refresh the page after editing Markdown. Press Ctrl+C to stop.');
});
