// T10: the tools.agentfleet.team directory page is generated from the README Tools table.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
// @ts-expect-error plain ES module without types
import { parseTools, renderPage } from '../tools-site/render.mjs';

const readme = readFileSync(join(import.meta.dirname, '..', 'README.md'), 'utf8');
const committed = readFileSync(join(import.meta.dirname, '..', 'tools-site', 'index.html'), 'utf8');

test('P1: the committed page equals the render of the README table', () => {
  assert.equal(committed, renderPage(readme));
});

test('P1: every README Tools row appears on the page with one line and its link', () => {
  const rows = parseTools(readme) as { name: string; line: string; href: string }[];
  assert.ok(rows.length >= 2);
  for (const r of rows) {
    assert.ok(committed.includes(`<h2>${r.name}</h2>`), r.name);
    assert.ok(committed.includes(`href="${r.href}"`), r.href);
    assert.ok(!r.line.includes('\n') && r.line.length > 0);
  }
});

test('P1: a new table row changes the page with no other edit', () => {
  const row = '| Voice | Text in, a spoken file out. Second sentence. | planned | [voice](https://voice.example.test/) |\n';
  const withRow = readme.replace(/(\| Digest \|[^\n]*\n)/, `$1${row}`);
  assert.notEqual(withRow, readme);
  const page = renderPage(withRow) as string;
  assert.match(page, /<h2>Voice<\/h2>/);
  assert.match(page, /<p>Text in, a spoken file out\.<\/p>/);
  assert.match(page, /href="https:\/\/voice\.example\.test\/"/);
  assert.notEqual(page, committed);
});

test('P1: a row without an https link fails the render', () => {
  const bad = readme.replace(/(\| Digest \|[^\n]*)\[Digest code\]\([^)]*\)/, '$1none');
  assert.throws(() => renderPage(bad), /no https link/);
});

test('P2: the page has no script tag, form, input or sign-in', () => {
  assert.doesNotMatch(committed, /<script/i);
  assert.doesNotMatch(committed, /<form|<input|<button/i);
  assert.doesNotMatch(committed, /sign[- ]?in|login|\/auth\//i);
  assert.doesNotMatch(committed, /\son[a-z]+=/i);
});

test('page text is escaped', () => {
  const evil = readme.replace('| Digest |', '| <b>x</b> |');
  assert.ok(!(renderPage(evil) as string).includes('<b>x</b>'));
});
