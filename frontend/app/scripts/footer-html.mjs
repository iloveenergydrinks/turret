import {existsSync, readFileSync} from 'node:fs';
function asset(name) {
  const source = new URL(`../public/${name}`, import.meta.url);
  return readFileSync(existsSync(source) ? source : new URL(`../out/${name}`, import.meta.url), 'utf8');
}
const css = asset('turret-footer-v2.css');
const js = asset('turret-footer-v2.js');
export function withFooter(html) {
  if (html.includes('data-turret-footer-layout')) return html;
  return html.replace(/src="\/turret-footer-(?:social-20260911|legal-v1)\.js"/g, 'src="/turret-footer-legal-v1.js?v=footer-v2"').replace(/<\/head>/i, `<style data-turret-footer-layout>${css}</style></head>`)
    .replace(/<\/body>/i, `<script data-cookieconsent="ignore">${js}</script></body>`);
}
