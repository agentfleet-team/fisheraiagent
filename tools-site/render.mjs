// Renders tools-site/index.html from the Tools table in README.md.
// Usage: node tools-site/render.mjs          write index.html
//        node tools-site/render.mjs --check  exit 1 when index.html is stale
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pageFile = join(root, 'tools-site', 'index.html');

const escapeHtml = (s) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const cells = (line) =>
  line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());

/** Rows of the first table under the "## Tools" heading, keyed by header name. */
export function parseTools(readme) {
  const lines = readme.split('\n');
  const start = lines.findIndex((l) => /^##\s+Tools\s*$/.test(l));
  if (start < 0) throw new Error('README has no "## Tools" section');
  const table = [];
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,6}\s/.test(line)) break;
    if (line.trim().startsWith('|')) table.push(line);
    else if (table.length) break;
  }
  if (table.length < 3) throw new Error('Tools section has no table rows');
  const header = cells(table[0]).map((h) => h.toLowerCase());
  const col = (name) => {
    const i = header.indexOf(name);
    if (i < 0) throw new Error(`Tools table has no "${name}" column`);
    return i;
  };
  const [iName, iWhat, iLink] = [col('tool'), col('what it does'), col('link')];
  return table.slice(2).map((line) => {
    const c = cells(line);
    const link = /\]\((https:\/\/[^)\s]+)\)/.exec(c[iLink] ?? '');
    if (!link) throw new Error(`Tools row "${c[iName]}" has no https link in its Link column`);
    const plain = (c[iWhat] ?? '').replace(/`/g, '');
    const oneLine = /^.*?[.!?](?=\s|$)/.exec(plain)?.[0] ?? plain;
    return { name: c[iName], line: oneLine, href: link[1] };
  });
}

const STYLE = `
:root { --navy: #0b2d50; --ivory: #f5f5ef; --coral: #ee886f; --navy-line: #24476b; --ink-2: #a9bccd;
  --display: ui-serif, "New York", "Iowan Old Style", "Hiragino Mincho ProN", "Noto Serif TC", Georgia, serif;
  --sans: ui-sans-serif, system-ui, -apple-system, "Segoe UI", "Helvetica Neue", "PingFang TC", "Noto Sans TC", sans-serif; }
*, *::before, *::after { box-sizing: border-box; }
html { color-scheme: dark; background: var(--navy); }
body { margin: 0; font: 400 1rem / 1.6 var(--sans); color: var(--ivory); background: var(--navy); }
a { color: var(--ivory); text-decoration-thickness: 1px; text-underline-offset: 3px; }
:focus-visible { outline: 2px solid var(--ivory); outline-offset: 3px; }
.site-bar { display: flex; align-items: center; padding: 12px clamp(16px, 4vw, 40px); border-bottom: 1px solid var(--navy-line); }
.brand { display: inline-flex; align-items: center; gap: 12px; text-decoration: none; font-weight: 600; }
.brand-mark { display: grid; place-items: center; width: 38px; height: 38px; border-radius: 10px; background: var(--ivory); }
.brand-mark img { display: block; width: 30px; height: 30px; }
main { max-width: 720px; margin: 0 auto; padding: 48px clamp(16px, 4vw, 40px) 80px; }
h1 { margin: 0 0 12px; font: 500 clamp(2.5rem, 1.7rem + 3.2vw, 4rem) / 1.02 var(--display); letter-spacing: -0.025em; }
.tagline { margin: 0 0 40px; max-width: 34ch; font-size: 1.125rem; color: var(--ink-2); }
ul { margin: 0; padding: 0; list-style: none; }
li { padding: 20px 0; border-top: 1px solid var(--navy-line); }
li:last-child { border-bottom: 1px solid var(--navy-line); }
h2 { margin: 0 0 4px; font: 500 1.75rem / 1.2 var(--display); }
li p { margin: 0 0 8px; color: var(--ink-2); }
`.trim();

export function renderPage(readme) {
  const items = parseTools(readme)
    .map(
      (t) =>
        `      <li>\n        <h2>${escapeHtml(t.name)}</h2>\n        <p>${escapeHtml(t.line)}</p>\n        <a href="${escapeHtml(t.href)}">Open ${escapeHtml(t.name)}</a>\n      </li>`,
    )
    .join('\n');
  const sha = createHash('sha256').update(JSON.stringify(parseTools(readme))).digest('hex');
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="dark">
  <meta name="theme-color" content="#0b2d50">
  <meta name="generator" content="tools-site/render.mjs; table sha256 ${sha}">
  <title>Tools · AgentFleet</title>
  <link rel="icon" href="/brand/agentfleet-mark.svg" type="image/svg+xml">
  <style>
${STYLE}
  </style>
</head>
<body>
  <header class="site-bar">
    <a class="brand" href="https://agentfleet.team/">
      <span class="brand-mark"><img src="/brand/agentfleet-mark.svg" width="30" height="30" alt=""></span>
      <span>AgentFleet</span>
    </a>
  </header>
  <main>
    <h1>Tools</h1>
    <p class="tagline">Open-source AI agent tools. Pick one.</p>
    <ul>
${items}
    </ul>
  </main>
</body>
</html>
`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const html = renderPage(readFileSync(join(root, 'README.md'), 'utf8'));
  if (process.argv.includes('--check')) {
    if (readFileSync(pageFile, 'utf8') !== html) {
      console.error('tools-site/index.html is stale; run: node tools-site/render.mjs');
      process.exit(1);
    }
  } else {
    writeFileSync(pageFile, html);
  }
}
