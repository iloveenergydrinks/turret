// Load the small enhancer in the shared shell so Next client navigation into Earn works too.
export function withEarnKnight(html) {
  if (html.includes('data-earn-knight-runtime')) return html;
  return html.replace('</head>', '<link rel="stylesheet" href="/earn-knight-20260912/entry.css"><script type="module" src="/earn-knight-20260912/entry.js" data-cookieconsent="ignore" data-earn-knight-runtime></script></head>');
}
