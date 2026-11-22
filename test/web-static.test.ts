// Static-asset caching (Issue #50): the page must always load the script
// that matches the running build. HTML and unversioned URLs are served
// uncacheable, and the asset URLs the page references carry the build
// commit (?v=<commit>) so a versioned URL may be cached long without
// ever drifting a deploy behind.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createService, type ServiceOptions } from '../src/service.js';
import type { GeminiCaller } from '../src/gemini.js';

const COMMIT = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';
const FRESH = 'no-cache, no-store';
const VERSIONED = 'public, max-age=31536000, immutable';

// The static paths never invoke the model; a stub caller keeps the
// service constructor honest without standing in for Gemini.
const stubCaller =
  (): ((apiKey: string) => GeminiCaller) =>
  () =>
  async () => ({ text: 'LANGUAGE: en', status: 'completed' });

async function startService(
  overrides: Partial<ServiceOptions> = {},
): Promise<{ base: string; close: () => Promise<void> }> {
  const server: Server = createService({
    callerFactory: stubCaller(),
    model: 'test-model',
    maxBlockSeconds: 8,
    cacheDir: mkdtempSync(join(tmpdir(), 'fa-web-static-')),
    ...overrides,
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test('S1: the page is never cacheable and stamps its asset URLs with the commit', async () => {
  const { base, close } = await startService({ version: 'v9.9.9', commit: COMMIT });
  try {
    const res = await fetch(`${base}/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /text\/html/);
    assert.equal(res.headers.get('cache-control'), FRESH);
    const html = await res.text();
    assert.equal(Number(res.headers.get('content-length')), Buffer.byteLength(html));
    assert.match(html, new RegExp(`src="/app\\.js\\?v=${COMMIT}"`));
    assert.match(html, new RegExp(`href="/styles\\.css\\?v=${COMMIT}"`));
    // Links that are not served assets keep their plain URL.
    assert.match(html, /href="\/auth\/login"/);
  } finally {
    await close();
  }
});

test('S2: a versioned asset URL may be cached long; unversioned URLs and HTML may not', async () => {
  const { base, close } = await startService({ commit: COMMIT });
  try {
    const js = await fetch(`${base}/app.js?v=${COMMIT}`);
    assert.equal(js.status, 200);
    assert.equal(js.headers.get('cache-control'), VERSIONED);
    await js.text();

    // Any stamp names its build; a stale one is still a versioned URL.
    const css = await fetch(`${base}/styles.css?v=older-build`);
    assert.equal(css.status, 200);
    assert.equal(css.headers.get('cache-control'), VERSIONED);
    await css.text();

    const unversioned = await fetch(`${base}/app.js`);
    assert.equal(unversioned.status, 200);
    assert.equal(unversioned.headers.get('cache-control'), FRESH);
    await unversioned.text();

    // HTML is never a long-cache entry, even under a versioned URL.
    const html = await fetch(`${base}/index.html?v=${COMMIT}`);
    assert.equal(html.status, 200);
    assert.equal(html.headers.get('cache-control'), FRESH);
    await html.text();
  } finally {
    await close();
  }
});

test('S3: the dev default stamps its placeholder, HEAD still answers, and misses stay 404', async () => {
  const { base, close } = await startService();
  try {
    const html = await (await fetch(`${base}/`)).text();
    assert.match(html, /src="\/app\.js\?v=unknown"/);

    const head = await fetch(`${base}/`, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get('cache-control'), FRESH);
    assert.equal(await head.text(), '');

    assert.equal((await fetch(`${base}/nope`)).status, 404);
    assert.equal((await fetch(`${base}/%2e%2e%2fpackage.json`)).status, 404);
  } finally {
    await close();
  }
});
