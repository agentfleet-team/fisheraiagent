// Browser test for the web page (Issue #3). Drives a real Chromium against the
// HTTP service with a Gemini test double — no network, no real key.
// Run: npm run test:web (requires `npx playwright-core install chromium` once).
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { chromium, type Browser, type Page, type Request } from 'playwright-core';
import { createService } from '../../src/service.js';
import { TranscriptError } from '../../src/errors.js';
import type { GeminiCaller, GeminiVideoRequest } from '../../src/gemini.js';

const GOOD = readFileSync(new URL('../fixtures/model-good.txt', import.meta.url), 'utf8');
const VIDEO_OK = 'hWe-j78vNpc';
const VIDEO_FAIL = 'dQw4w9WgXcQ';
const KEY_OK = 'WEB-TEST-KEY-OK-zz11';
const KEY_FAIL = 'WEB-TEST-KEY-FAIL-zz22';
const LS_KEY = 'geminiApiKey';
const SHOTS = fileURLToPath(new URL('./screenshots/', import.meta.url));

const calls: { apiKey: string; req: GeminiVideoRequest }[] = [];
const logs: string[] = [];
let base = '';
let server: Server;
let browser: Browser;

const doubleFactory =
  (): ((apiKey: string) => GeminiCaller) =>
  (apiKey) =>
  async (req) => {
    calls.push({ apiKey, req });
    if (apiKey === KEY_FAIL) {
      throw new TranscriptError('video_unavailable', 'video is private or removed');
    }
    return { text: GOOD, status: 'completed' };
  };

async function newPage(options: { locale?: string; width?: number; height?: number } = {}): Promise<{
  page: Page;
  requests: Request[];
}> {
  const context = await browser.newContext({
    locale: options.locale ?? 'en-US',
    viewport: { width: options.width ?? 1280, height: options.height ?? 900 },
  });
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base });
  const page = await context.newPage();
  const requests: Request[] = [];
  page.on('request', (r) => requests.push(r));
  return { page, requests };
}

async function storeKey(page: Page, key: string): Promise<void> {
  await page.click('#settings-btn');
  await page.fill('#key-input', key);
  await page.click('#save-key');
  await page.click('#close-drawer');
}

async function submitUrl(page: Page, url: string): Promise<void> {
  await page.fill('#url-input', url);
  await page.click('#submit-btn');
}

before(async () => {
  server = createService({
    callerFactory: doubleFactory(),
    model: 'test-model',
    maxBlockSeconds: 8,
    cacheDir: mkdtempSync(join(tmpdir(), 'fa-web-cache-')),
    log: (line) => logs.push(line),
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  mkdirSync(SHOTS, { recursive: true });
  browser = await chromium.launch();
});

after(async () => {
  await browser?.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test('C1: transcript blocks render below the box with timestamps', async () => {
  const { page } = await newPage();
  try {
    await page.goto(`${base}/`);
    await storeKey(page, KEY_OK);
    await submitUrl(page, `https://youtu.be/${VIDEO_OK}`);

    await page.waitForSelector('#blocks li', { timeout: 20000 });
    const items = page.locator('#blocks li');
    assert.equal(await items.count(), 5);

    const firstTs = await page.locator('#blocks li .ts').first().textContent();
    assert.match(firstTs ?? '', /^\[\d+:\d{2}\]/);
    const firstText = await items.first().textContent();
    assert.match(firstText ?? '', /technique/);

    // The result is below the input box on the same page.
    const inputBox = (await page.locator('#url-input').boundingBox())!;
    const resultBox = (await page.locator('#result').boundingBox())!;
    assert.ok(resultBox.y > inputBox.y + inputBox.height, 'result is not below the input box');

    await page.screenshot({ path: join(SHOTS, 'page-1280.png'), fullPage: true });

    // Copy round-trips the timestamped text.
    await page.click('#copy-btn');
    const clip = await page.evaluate(() => navigator.clipboard.readText());
    assert.match(clip, /^\[0:00\] There's this technique/);
  } finally {
    await page.context().close();
  }
});

test('C2: .txt and .srt downloads are valid', async () => {
  const { page } = await newPage();
  try {
    await page.goto(`${base}/`);
    await storeKey(page, KEY_OK);
    await submitUrl(page, `https://youtu.be/${VIDEO_OK}`);
    await page.waitForSelector('#blocks li', { timeout: 20000 });

    const [txtDownload] = await Promise.all([
      page.waitForEvent('download'),
      page.click('#download-txt'),
    ]);
    const txt = readFileSync((await txtDownload.path())!, 'utf8');
    assert.match(txt, /^\[0:00\] There's this technique that I use all the time\./);
    assert.equal(txt.trim().split('\n').length, 5);

    const [srtDownload] = await Promise.all([
      page.waitForEvent('download'),
      page.click('#download-srt'),
    ]);
    const srt = readFileSync((await srtDownload.path())!, 'utf8');
    const cues = srt.trim().split(/\n\n+/);
    assert.equal(cues.length, 5);
    for (const [i, cue] of cues.entries()) {
      const lines = cue.split('\n');
      assert.equal(lines[0], String(i + 1));
      assert.match(lines[1], /^\d{2}:\d{2}:\d{2},\d{3} --> \d{2}:\d{2}:\d{2},\d{3}$/);
    }
    assert.match(srt, /00:00:00,000 --> 00:00:07,480\nThere's this technique/);
  } finally {
    await page.context().close();
  }
});

test('C3: with no stored key the page asks for a key and sends no job request', async () => {
  const { page, requests } = await newPage();
  try {
    await page.goto(`${base}/`);
    await submitUrl(page, `https://youtu.be/${VIDEO_OK}`);

    await page.waitForFunction(
      () => document.getElementById('status-text')?.textContent?.includes('Gemini API key'),
      { timeout: 5000 },
    );
    const jobPosts = requests.filter(
      (r) => r.url().includes('/v1/jobs') && r.method() === 'POST',
    );
    assert.equal(jobPosts.length, 0);
  } finally {
    await page.context().close();
  }
});

test('C4: the key is only in localStorage and the submit header, never in logs', async () => {
  const { page, requests } = await newPage();
  try {
    await page.goto(`${base}/`);
    await storeKey(page, KEY_OK);
    await submitUrl(page, `https://youtu.be/${VIDEO_OK}`);
    await page.waitForSelector('#blocks li', { timeout: 20000 });

    assert.equal(
      await page.evaluate((k) => localStorage.getItem(k), LS_KEY),
      KEY_OK,
    );
    const withKey = requests.filter((r) => r.headers()['x-gemini-key']);
    assert.equal(withKey.length, 1);
    assert.equal(withKey[0].method(), 'POST');
    assert.ok(withKey[0].url().endsWith('/v1/jobs'));
    assert.equal(withKey[0].headers()['x-gemini-key'], KEY_OK);
    for (const r of requests) {
      assert.ok(!(r.postData() ?? '').includes(KEY_OK), `key in body of ${r.url()}`);
      assert.ok(!r.url().includes(KEY_OK), `key in URL ${r.url()}`);
    }
    assert.ok(!logs.join('\n').includes(KEY_OK), 'key leaked into server logs');
  } finally {
    await page.context().close();
  }
});

test('C5: Remove clears the key from localStorage', async () => {
  const { page } = await newPage();
  try {
    await page.goto(`${base}/`);
    await storeKey(page, KEY_OK);
    assert.equal(await page.evaluate((k) => localStorage.getItem(k), LS_KEY), KEY_OK);

    await page.click('#settings-btn');
    await page.click('#remove-key');
    assert.equal(await page.evaluate((k) => localStorage.getItem(k), LS_KEY), null);
  } finally {
    await page.context().close();
  }
});

test('C6: video_unavailable shows a mapped message and the spinner stops', async () => {
  const { page } = await newPage();
  try {
    await page.goto(`${base}/`);
    await storeKey(page, KEY_FAIL);
    await submitUrl(page, `https://youtu.be/${VIDEO_FAIL}`);

    const statusText = page.locator('#status-text');
    await statusText.waitFor({ timeout: 20000 });
    await page.waitForFunction(
      () => document.getElementById('status-text')?.textContent?.includes('cannot be read'),
      { timeout: 20000 },
    );
    assert.ok(await page.locator('#status.error').count());
    assert.ok(await page.locator('#spinner').isHidden());
    assert.ok(await page.locator('#result').isHidden());
  } finally {
    await page.context().close();
  }
});

test('C7: zh-TW and en render, and 390 px has no horizontal scroll', async () => {
  const { page: zhPage } = await newPage({ locale: 'zh-TW' });
  try {
    await zhPage.goto(`${base}/`);
    assert.equal(await zhPage.locator('h1').textContent(), 'YouTube 逐字稿');
    assert.equal(await zhPage.locator('#submit-btn').textContent(), '產生逐字稿');
    await zhPage.click('#settings-btn');
    assert.equal(await zhPage.locator('#save-key').textContent(), '儲存');
  } finally {
    await zhPage.context().close();
  }

  const { page: enPage } = await newPage({ locale: 'en-US' });
  try {
    await enPage.goto(`${base}/`);
    assert.equal(await enPage.locator('#submit-btn').textContent(), 'Transcribe');
  } finally {
    await enPage.context().close();
  }

  // Full flow at phone width: works and does not scroll sideways.
  const { page: mobile } = await newPage({ width: 390, height: 844 });
  try {
    await mobile.goto(`${base}/`);
    await storeKey(mobile, KEY_OK);
    await submitUrl(mobile, `https://youtu.be/${VIDEO_OK}`);
    await mobile.waitForSelector('#blocks li', { timeout: 20000 });
    const scrollWidth = await mobile.evaluate(() => document.documentElement.scrollWidth);
    const innerWidth = await mobile.evaluate(() => window.innerWidth);
    assert.ok(scrollWidth <= innerWidth, `horizontal scroll: ${scrollWidth} > ${innerWidth}`);
    await mobile.screenshot({ path: join(SHOTS, 'page-390.png'), fullPage: true });
  } finally {
    await mobile.context().close();
  }
});
