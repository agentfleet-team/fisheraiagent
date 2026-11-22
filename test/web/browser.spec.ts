// Browser test for the web page (Issue #3). Drives a real Chromium against the
// HTTP service with a Gemini test double — no network, no real key.
// Run: npm run test:web (requires `npx playwright-core install chromium` once).
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { chromium, type Browser, type BrowserContext, type Page, type Request } from 'playwright-core';
import { createService } from '../../src/service.js';
import { TranscriptError } from '../../src/errors.js';
import type { GeminiCaller, GeminiVideoRequest } from '../../src/gemini.js';
import {
  cookiePair,
  FakeDrive,
  FakeOidcProvider,
  freePort,
  signInFlow,
} from '../fakes.js';

const GOOD = readFileSync(new URL('../fixtures/model-good.txt', import.meta.url), 'utf8');
const VIDEO_OK = 'hWe-j78vNpc';
const VIDEO_FAIL = 'dQw4w9WgXcQ';
const KEY_OK = 'WEB-TEST-KEY-OK-zz11';
const KEY_FAIL = 'WEB-TEST-KEY-FAIL-zz22';
const KEY_QUOTA = 'WEB-TEST-KEY-QUOTA-zz33';
const KEY_FORBIDDEN = 'WEB-TEST-KEY-FORBIDDEN-zz44';
const KEY_OFFLINE = 'WEB-TEST-KEY-OFFLINE-zz55';
const GEMINI_HOST = 'https://generativelanguage.googleapis.com';
const LS_KEY = 'geminiApiKey';
const SHOTS = fileURLToPath(new URL('./screenshots/', import.meta.url));

const calls: { apiKey: string; req: GeminiVideoRequest }[] = [];
const logs: string[] = [];
let base = '';
let server: Server;
let browser: Browser;

// The same model double the service tests use: the first answer carries
// the fixture transcript; a later window's answer is language-only, which
// the window loop reads as that range being silence. Answering every
// window with the same blocks is not a valid model and fails the job.
const doubleFactory =
  (): ((apiKey: string) => GeminiCaller) =>
  (apiKey) =>
  async (req) => {
    calls.push({ apiKey, req });
    if (apiKey === KEY_FAIL) {
      throw new TranscriptError('video_unavailable', 'video is private or removed');
    }
    // A continuation-window call answers "no more speech" — the way the
    // window loop learns the video ended (the service and hosted doubles
    // do the same). Answering GOOD again would loop the windows forever.
    return { text: (req.startOffsetSeconds ?? 0) > 0 ? 'LANGUAGE: en' : GOOD, status: 'completed' };
  };

// Issue #42: the page's save-time key check calls Gemini's models.get
// directly. Stand in for it so no test traffic reaches the real API.
async function stubGemini(context: BrowserContext): Promise<void> {
  await context.route(`${GEMINI_HOST}/**`, async (route) => {
    const key = route.request().headers()['x-goog-api-key'] ?? '';
    if (key === KEY_OFFLINE) return route.abort();
    const status =
      key === KEY_OK ? 200 : key === KEY_QUOTA ? 429 : key === KEY_FORBIDDEN ? 403 : 400;
    return route.fulfill({
      status,
      json: status === 200 ? { name: 'models/test-model' } : { error: { code: status } },
    });
  });
}

async function newPage(options: { locale?: string; width?: number; height?: number } = {}): Promise<{
  page: Page;
  requests: Request[];
}> {
  const context = await browser.newContext({
    locale: options.locale ?? 'en-US',
    viewport: { width: options.width ?? 1280, height: options.height ?? 900 },
  });
  await stubGemini(context);
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
    assert.match(srt, /00:00:00,000 --> 00:00:07,000\nThere's this technique/);
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

// Issue #42: saving a key verifies it with one direct call to Gemini
// (models.get for the service's model); the service only answers
// /v1/config. The Gemini responses above are test doubles.
test('C8: a working key verifies against the service model — key never reaches the service', async () => {
  const { page, requests } = await newPage();
  try {
    await page.goto(`${base}/`);
    await page.click('#settings-btn');
    await page.fill('#key-input', KEY_OK);
    await page.click('#save-key');
    await page.waitForFunction(
      () => document.getElementById('key-state')?.dataset.state === 'valid',
      { timeout: 10000 },
    );
    assert.match((await page.locator('#key-state').textContent()) ?? '', /verified/i);
    assert.equal(await page.evaluate((k) => localStorage.getItem(k), LS_KEY), KEY_OK);

    const checks = requests.filter((r) => r.url().startsWith(GEMINI_HOST));
    assert.equal(checks.length, 1);
    assert.match(checks[0].url(), /\/v1beta\/models\/test-model$/);
    assert.equal(checks[0].headers()['x-goog-api-key'], KEY_OK);
    // The only service call the check makes is /v1/config; no service
    // request ever carried the key.
    const toService = requests.filter((r) => r.url().startsWith(base));
    assert.ok(toService.some((r) => r.url().endsWith('/v1/config')));
    for (const r of toService) {
      assert.ok(
        !r.url().includes(KEY_OK) && !(r.postData() ?? '').includes(KEY_OK),
        `key leaked to the service in ${r.url()}`,
      );
    }
    assert.ok(!logs.join('\n').includes(KEY_OK), 'key leaked into server logs');
  } finally {
    await page.context().close();
  }
});

test('C9: a rejected key (400 and 403) shows the invalid state', async () => {
  const { page } = await newPage();
  try {
    await page.goto(`${base}/`);
    await page.click('#settings-btn');
    for (const key of [KEY_FAIL, KEY_FORBIDDEN]) {
      await page.fill('#key-input', key);
      await page.click('#save-key');
      await page.waitForFunction(
        () => document.getElementById('key-state')?.dataset.state === 'invalid',
        { timeout: 10000 },
      );
      assert.match((await page.locator('#key-state').textContent()) ?? '', /rejected/i);
      assert.equal(await page.evaluate((k) => localStorage.getItem(k), LS_KEY), key);
    }
  } finally {
    await page.context().close();
  }
});

test('C10: an out-of-quota key (429) shows the quota state', async () => {
  const { page } = await newPage();
  try {
    await page.goto(`${base}/`);
    await page.click('#settings-btn');
    await page.fill('#key-input', KEY_QUOTA);
    await page.click('#save-key');
    await page.waitForFunction(
      () => document.getElementById('key-state')?.dataset.state === 'quota',
      { timeout: 10000 },
    );
    assert.match((await page.locator('#key-state').textContent()) ?? '', /quota/i);
    assert.equal(await page.evaluate((k) => localStorage.getItem(k), LS_KEY), KEY_QUOTA);
  } finally {
    await page.context().close();
  }
});

test('C11: a check that cannot reach Gemini is reported and the key still stores', async () => {
  const { page } = await newPage();
  try {
    await page.goto(`${base}/`);
    await page.click('#settings-btn');
    await page.fill('#key-input', KEY_OFFLINE);
    await page.click('#save-key');
    await page.waitForFunction(
      () => document.getElementById('key-state')?.dataset.state === 'unavailable',
      { timeout: 10000 },
    );
    assert.match((await page.locator('#key-state').textContent()) ?? '', /could not reach/i);
    assert.equal(await page.evaluate((k) => localStorage.getItem(k), LS_KEY), KEY_OFFLINE);
  } finally {
    await page.context().close();
  }
});

// Issue #43: an over-limit submit shows the fixed 429 message on the page.
// The service gets its own instance with a one-job-per-hour client cap.
test('C12: a 429 over the per-client cap shows the rate-limit message', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fa-web-limit-'));
  const port = await freePort();
  const limited: Server = createService({
    callerFactory: doubleFactory(),
    model: 'test-model',
    maxBlockSeconds: 8,
    cacheDir: dir,
    maxJobsPerHourPerClient: 1,
  });
  await new Promise<void>((resolve) => limited.listen(port, '127.0.0.1', resolve));
  const limitedBase = `http://127.0.0.1:${port}`;
  const context = await browser.newContext({ locale: 'en-US' });
  await stubGemini(context);
  const page = await context.newPage();
  try {
    await page.goto(`${limitedBase}/`);
    await storeKey(page, KEY_OK);
    await submitUrl(page, `https://youtu.be/${VIDEO_OK}`);
    await page.waitForSelector('#blocks li', { timeout: 20000 });

    await submitUrl(page, `https://youtu.be/${VIDEO_FAIL}`);
    await page.waitForFunction(
      () => document.getElementById('status-text')?.textContent?.includes('Too many jobs'),
      { timeout: 10000 },
    );
    assert.ok(await page.locator('#status.error').count());
    assert.ok(await page.locator('#spinner').isHidden());
  } finally {
    await context.close();
    await new Promise<void>((resolve) => limited.close(() => resolve()));
  }
});

// Issue #6: a signed-in tenant user. The service gets its own instance with
// OIDC configured against the fake provider; the session cookie rides into
// the browser context like the real callback would leave it.
test('H1-web: a signed-in tenant user sees the saved-file link on the page', async () => {
  const provider = new FakeOidcProvider();
  await provider.start();
  const drive = new FakeDrive();
  const dir = mkdtempSync(join(tmpdir(), 'fa-web-tenant-'));
  writeFileSync(
    join(dir, 'tenants.json'),
    JSON.stringify({
      tenants: [
        {
          id: 'tenant-a',
          web_emails: ['alice@example.com'],
          destination: { type: 'google-drive', folder_id: 'folder-a' },
        },
      ],
    }),
  );
  const port = await freePort();
  const authed: Server = createService({
    callerFactory: doubleFactory(),
    model: 'test-model',
    maxBlockSeconds: 8,
    cacheDir: dir,
    tenantsFile: join(dir, 'tenants.json'),
    drive,
    videoMetadata: async () => ({}),
    oidc: {
      clientId: provider.clientId,
      clientSecret: provider.clientSecret,
      issuer: provider.issuer,
      redirectUri: `http://127.0.0.1:${port}/auth/callback`,
      sessionSecret: 'test-session-secret-0123456789',
    },
  });
  await new Promise<void>((resolve) => authed.listen(port, '127.0.0.1', resolve));
  const authedBase = `http://127.0.0.1:${port}`;
  try {
    const setCookie = await signInFlow(authedBase);
    const pair = cookiePair(setCookie);
    const eq = pair.indexOf('=');
    const context = await browser.newContext();
    await stubGemini(context);
    await context.addCookies([
      {
        name: pair.slice(0, eq),
        value: pair.slice(eq + 1),
        url: authedBase,
        httpOnly: true,
        secure: true,
        sameSite: 'Lax',
      },
    ]);
    const page = await context.newPage();
    try {
      await page.goto(`${authedBase}/`);
      // The signed-in box shows the allowlisted identity and tenant.
      await page.waitForSelector('#signed-in:not([hidden])', { timeout: 10000 });
      const label = (await page.locator('#user-label').textContent()) ?? '';
      assert.match(label, /alice@example\.com/);
      assert.match(label, /tenant-a/);
      assert.ok(await page.locator('#signin-link').isHidden());

      await storeKey(page, KEY_OK);
      await submitUrl(page, `https://youtu.be/${VIDEO_OK}`);

      // The saved-file link appears above the transcript blocks.
      await page.waitForSelector('#saved-link', { state: 'visible', timeout: 20000 });
      const href = await page.locator('#saved-link').getAttribute('href');
      const files = drive.filesIn('folder-a');
      assert.equal(files.length, 1);
      assert.equal(href, files[0].url);
      assert.ok(await page.locator('#blocks li').count());
    } finally {
      await context.close();
    }
  } finally {
    await new Promise<void>((resolve) => authed.close(() => resolve()));
    await provider.stop();
  }
});
