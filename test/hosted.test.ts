// Hosted-instance tests (Issue #6): OIDC sign-in to a tenant, per-tenant
// limits, and the deploy/aws recipe's genericness — all offline, against a
// fake OIDC provider that signs real RS256 id_tokens.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { createService, type ServiceOptions } from '../src/service.js';
import type { GeminiCaller, GeminiVideoRequest } from '../src/gemini.js';
import { cookiePair, FakeDrive, FakeOidcProvider, freePort, signInFlow } from './fakes.js';

const GOOD = readFileSync(new URL('./fixtures/model-good.txt', import.meta.url), 'utf8');
const SHORT = 'DURATION: 8\nLANGUAGE: en\n[0.000 - 7.480] A short video says hello.\n';
const VIDEO_A = 'hWe-j78vNpc';
const VIDEO_SHORT = 'dQw4w9WgXcQ';
const KEY = 'TEST-KEY-HOSTED-q4q4q4';

interface GeminiCall {
  apiKey: string;
  req: GeminiVideoRequest;
}

const doubleFactory =
  (calls: GeminiCall[], texts: Record<string, string> = {}) =>
  (apiKey: string): GeminiCaller =>
  async (req) => {
    calls.push({ apiKey, req });
    const videoId = /v=([A-Za-z0-9_-]{11})/.exec(req.videoUrl)?.[1] ?? '';
    return { text: texts[videoId] ?? GOOD, status: 'completed' };
  };

interface Running {
  base: string;
  logs: string[];
  close: () => Promise<void>;
}

// A service on a known port: the OIDC redirect_uri must name the service's
// own callback URL, so the port is probed before createService runs.
async function startHosted(
  calls: GeminiCall[],
  opts: {
    provider?: FakeOidcProvider;
    tenants?: unknown;
    overrides?: Partial<ServiceOptions>;
    texts?: Record<string, string>;
  } = {},
): Promise<Running> {
  const logs: string[] = [];
  const dir = mkdtempSync(join(tmpdir(), 'fa-hosted-'));
  const options: ServiceOptions = {
    callerFactory: doubleFactory(calls, opts.texts),
    model: 'test-model',
    maxBlockSeconds: 8,
    cacheDir: dir,
    log: (line) => logs.push(line),
    ...opts.overrides,
  };
  const port = await freePort();
  if (opts.provider) {
    options.oidc = {
      clientId: opts.provider.clientId,
      clientSecret: opts.provider.clientSecret,
      issuer: opts.provider.issuer,
      redirectUri: `http://127.0.0.1:${port}/auth/callback`,
      sessionSecret: 'test-session-secret-0123456789',
    };
  }
  if (opts.tenants !== undefined) {
    const tenantsFile = join(dir, 'tenants.json');
    writeFileSync(tenantsFile, JSON.stringify({ tenants: opts.tenants }));
    options.tenantsFile = tenantsFile;
  }
  const server: Server = createService(options);
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  return {
    base: `http://127.0.0.1:${port}`,
    logs,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function postJob(
  base: string,
  opts: { url?: string; cookie?: string; origin?: unknown; token?: string } = {},
): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = { 'content-type': 'application/json', 'x-gemini-key': KEY };
  if (opts.cookie) headers.cookie = opts.cookie;
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  const res = await fetch(`${base}/v1/jobs`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      url: opts.url ?? `https://youtu.be/${VIDEO_A}`,
      ...(opts.origin !== undefined ? { origin: opts.origin } : {}),
    }),
  });
  return { status: res.status, body: await res.json() };
}

async function pollJob(base: string, id: string): Promise<any> {
  for (let i = 0; i < 500; i++) {
    const res = await fetch(`${base}/v1/jobs/${id}`);
    const body = await res.json();
    assert.equal(res.status, 200);
    if (body.status === 'done' || body.status === 'failed') return body;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.fail('job did not finish in time');
}

const TENANTS_WEB = [
  {
    id: 'tenant-a',
    web_emails: ['alice@example.com'],
    destination: { type: 'google-drive', folder_id: 'folder-a' },
  },
  {
    id: 'tenant-b',
    discord_guild_id: 'guild-b',
    caller: { token_env: 'TEST_TOKEN_B_NEVER_SET' },
    destination: { type: 'google-drive', folder_id: 'folder-b' },
  },
];

// --- H1: allowlisted email signs in and its job saves to its tenant ----------

test('H1: an allowlisted email signs in through OIDC+PKCE and its job saves to its tenant', async () => {
  const provider = new FakeOidcProvider();
  await provider.start();
  const calls: GeminiCall[] = [];
  const drive = new FakeDrive();
  const svc = await startHosted(calls, {
    provider,
    tenants: TENANTS_WEB,
    overrides: { drive, videoMetadata: async () => ({}) },
  });
  try {
    const setCookie = await signInFlow(svc.base);
    assert.ok(provider.tokenCalls > 0, 'the code was never redeemed');
    assert.notEqual(provider.seenVerifier, '', 'no PKCE verifier reached the provider');
    // The state + PKCE challenge the service registered is what the
    // provider verified.
    assert.notEqual(provider.seenState, '');
    assert.notEqual(provider.seenChallenge, '');

    const me = await fetch(`${svc.base}/auth/me`, { headers: { cookie: cookiePair(setCookie) } });
    const meBody = await me.json();
    assert.equal(meBody.signed_in, true);
    assert.equal(meBody.email, 'alice@example.com');
    assert.equal(meBody.tenant, 'tenant-a');

    const res = await postJob(svc.base, { cookie: cookiePair(setCookie) });
    assert.equal(res.status, 202);
    const job = await pollJob(svc.base, res.body.job_id);
    assert.equal(job.status, 'done');
    assert.ok(job.saved, 'job did not save');
    const files = drive.filesIn('folder-a');
    assert.equal(files.length, 1);
    assert.equal(job.saved.url, files[0].url);
    assert.equal(drive.filesIn('folder-b').length, 0);
    // The transcript still comes back too.
    assert.equal(job.result.video_id, VIDEO_A);
  } finally {
    await svc.close();
    await provider.stop();
  }
});

// --- H2: signed in but not allowlisted ---------------------------------------

test('H2: a signed-in email on no allowlist gets the transcript, no save, the fixed message', async () => {
  const provider = new FakeOidcProvider();
  await provider.start();
  provider.email = 'bob@nowhere.example';
  const calls: GeminiCall[] = [];
  const drive = new FakeDrive();
  const svc = await startHosted(calls, {
    provider,
    tenants: TENANTS_WEB,
    overrides: { drive },
  });
  try {
    const setCookie = await signInFlow(svc.base);
    const res = await postJob(svc.base, { cookie: cookiePair(setCookie) });
    assert.equal(res.status, 202);
    const job = await pollJob(svc.base, res.body.job_id);
    assert.equal(job.status, 'done');
    assert.ok(job.result, 'no transcript returned');
    assert.equal(job.saved, undefined);
    assert.equal(job.save_error.code, 'no_tenant');
    assert.equal(drive.files.length, 0);
  } finally {
    await svc.close();
    await provider.stop();
  }
});

// --- H3: a signed-in user cannot cross into another tenant -------------------

test('H3: a signed-in tenant-A user claiming tenant B saves to A only', async () => {
  const provider = new FakeOidcProvider();
  await provider.start();
  const calls: GeminiCall[] = [];
  const drive = new FakeDrive();
  const svc = await startHosted(calls, {
    provider,
    tenants: TENANTS_WEB,
    overrides: { drive },
  });
  try {
    const setCookie = await signInFlow(svc.base);
    const res = await postJob(svc.base, {
      cookie: cookiePair(setCookie),
      origin: { kind: 'discord', guild_id: 'guild-b', channel_id: 'chan-b' },
      token: 'some-b-token',
    });
    assert.equal(res.status, 202);
    const job = await pollJob(svc.base, res.body.job_id);
    assert.equal(job.status, 'done');
    assert.equal(drive.filesIn('folder-a').length, 1);
    assert.equal(drive.filesIn('folder-b').length, 0, 'a job landed in tenant B');
  } finally {
    await svc.close();
    await provider.stop();
  }
});

// --- H4: session cookie security ---------------------------------------------

test('H4: cookie flags, a tampered cookie and a bad state are all rejected', async () => {
  const provider = new FakeOidcProvider();
  await provider.start();
  const calls: GeminiCall[] = [];
  const drive = new FakeDrive();
  const svc = await startHosted(calls, {
    provider,
    tenants: TENANTS_WEB,
    overrides: { drive },
  });
  try {
    const setCookie = await signInFlow(svc.base);
    assert.match(setCookie, /HttpOnly/i);
    assert.match(setCookie, /Secure/i);
    assert.match(setCookie, /SameSite=Lax/i);

    // A tampered cookie is anonymous: no session, no tenant, no save.
    const pair = cookiePair(setCookie);
    const tampered = `${pair.slice(0, -4)}AAAA`;
    const me = await fetch(`${svc.base}/auth/me`, { headers: { cookie: tampered } });
    const meBody = await me.json();
    assert.equal(meBody.signed_in, false);
    const res = await postJob(svc.base, { cookie: tampered });
    const job = await pollJob(svc.base, res.body.job_id);
    assert.equal(job.status, 'done');
    assert.equal(job.saved, undefined);
    assert.equal(drive.files.length, 0);

    // A callback with a state the service never issued is rejected.
    const bad = await fetch(`${svc.base}/auth/callback?code=x&state=bogus-state`, {
      redirect: 'manual',
    });
    assert.equal(bad.status, 400);

    // A used state cannot be replayed: the first callback succeeds, the
    // second with the same URL is rejected (the pending login is consumed).
    const login = await fetch(`${svc.base}/auth/login`, { redirect: 'manual' });
    const authorizeUrl = login.headers.get('location');
    assert.ok(authorizeUrl);
    const authorize = await fetch(authorizeUrl, { redirect: 'manual' });
    const callbackUrl = authorize.headers.get('location');
    assert.ok(callbackUrl);
    const first = await fetch(callbackUrl, { redirect: 'manual' });
    assert.equal(first.status, 302);
    const again = await fetch(callbackUrl, { redirect: 'manual' });
    assert.equal(again.status, 400);
  } finally {
    await svc.close();
    await provider.stop();
  }
});

// --- H5: per-tenant limits ----------------------------------------------------

test('H5: jobs_per_hour and max_video_seconds reject with the fixed messages', async () => {
  const provider = new FakeOidcProvider();
  await provider.start();
  const calls: GeminiCall[] = [];
  const drive = new FakeDrive();
  const svc = await startHosted(calls, {
    provider,
    tenants: [
      {
        id: 'tenant-ltd',
        web_emails: ['alice@example.com'],
        destination: { type: 'none' },
        limits: { max_video_seconds: 60, jobs_per_hour: 2 },
      },
    ],
    overrides: { drive },
    texts: { [VIDEO_A]: GOOD, [VIDEO_SHORT]: SHORT },
  });
  try {
    const cookie = cookiePair(await signInFlow(svc.base));

    // Job 1 (30 s): within the limit, completes.
    const res1 = await postJob(svc.base, { cookie, url: `https://youtu.be/${VIDEO_SHORT}` });
    assert.equal(res1.status, 202);
    const job1 = await pollJob(svc.base, res1.body.job_id);
    assert.equal(job1.status, 'done');

    // Job 2 (534 s declared on the first response): fails video_too_long
    // after exactly one Gemini call — no continuation calls are spent.
    const before2 = calls.length;
    const res2 = await postJob(svc.base, { cookie, url: `https://youtu.be/${VIDEO_A}` });
    assert.equal(res2.status, 202);
    const job2 = await pollJob(svc.base, res2.body.job_id);
    assert.equal(job2.status, 'failed');
    assert.equal(job2.error.code, 'video_too_long');
    assert.equal(calls.length, before2 + 1);

    // Job 3: over the hourly cap — the fixed rate_limited message and no job.
    const res3 = await postJob(svc.base, { cookie, url: `https://youtu.be/${VIDEO_SHORT}` });
    assert.equal(res3.status, 429);
    assert.equal(res3.body.error.code, 'rate_limited');
    assert.equal(calls.length, before2 + 1, 'a rate-limited job still called Gemini');
  } finally {
    await svc.close();
    await provider.stop();
  }
});

test('H5b: a length known before any call fails the job with zero Gemini calls', async () => {
  const provider = new FakeOidcProvider();
  await provider.start();
  const calls: GeminiCall[] = [];
  const svc = await startHosted(calls, {
    provider,
    tenants: [
      {
        id: 'tenant-ltd',
        web_emails: ['alice@example.com'],
        destination: { type: 'none' },
        limits: { max_video_seconds: 60 },
      },
    ],
    overrides: { knownDurationSeconds: async () => 700 },
  });
  try {
    const cookie = cookiePair(await signInFlow(svc.base));
    const res = await postJob(svc.base, { cookie });
    assert.equal(res.status, 202);
    const job = await pollJob(svc.base, res.body.job_id);
    assert.equal(job.status, 'failed');
    assert.equal(job.error.code, 'video_too_long');
    assert.equal(calls.length, 0, 'Gemini was called for a job rejected before it');
  } finally {
    await svc.close();
    await provider.stop();
  }
});

// --- H6: anonymous default ----------------------------------------------------

test('H6: with sign-in unconfigured the service behaves as before', async () => {
  const calls: GeminiCall[] = [];
  const svc = await startHosted(calls);
  try {
    const me = await fetch(`${svc.base}/auth/me`);
    assert.equal(me.status, 404);
    const login = await fetch(`${svc.base}/auth/login`, { redirect: 'manual' });
    assert.equal(login.status, 404);

    const res = await postJob(svc.base);
    assert.equal(res.status, 202);
    const job = await pollJob(svc.base, res.body.job_id);
    assert.equal(job.status, 'done');
    assert.equal(job.saved, undefined);
    assert.equal(job.save_error, undefined);
  } finally {
    await svc.close();
  }
});

// --- H7: the deploy recipe is generic ----------------------------------------

test('H7: deploy/aws holds no account ids, real domains or tenant data', () => {
  const dir = join(import.meta.dirname, '..', 'deploy', 'aws');
  const files: string[] = [];
  const walk = (d: string): void => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else files.push(p);
    }
  };
  walk(dir);
  assert.ok(files.length > 0, 'deploy/aws is empty');
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    assert.doesNotMatch(text, /\b\d{12}\b/, `${file}: looks like an AWS account id`);
    assert.doesNotMatch(text, /@[a-z0-9.-]+\.[a-z]{2,}/i, `${file}: an email or domain leaked`);
    assert.doesNotMatch(
      text,
      /"(web_emails|folder_id|discord_guild_id|tenants)"\s*:/,
      `${file}: tenant config data leaked`,
    );
  }
});
