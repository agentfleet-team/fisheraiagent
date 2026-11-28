import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConnection, type AddressInfo } from 'node:net';
import { request, type ClientRequest, type Server } from 'node:http';
import { createService, type ServiceOptions } from '../src/service.js';
import { TranscriptError } from '../src/errors.js';
import type { CaptionRead } from '../src/captions.js';
import type { GeminiCaller, GeminiVideoRequest } from '../src/gemini.js';

const GOOD = readFileSync(new URL('./fixtures/model-good.txt', import.meta.url), 'utf8');
const VIDEO_A = 'hWe-j78vNpc';
const VIDEO_B = 'dQw4w9WgXcQ';
const KEY_A = 'TEST-KEY-ALPHA-x9x9x9';
const KEY_B = 'TEST-KEY-BRAVO-y8y8y8';

interface GeminiCall {
  apiKey: string;
  req: GeminiVideoRequest;
}

function doubleFactory(
  calls: GeminiCall[],
  errors?: ReadonlyMap<string, unknown>,
): (apiKey: string) => GeminiCaller {
  return (apiKey) => async (req) => {
    calls.push({ apiKey, req });
    const err = errors?.get(apiKey);
    if (err) throw err;
    const text = (req.startOffsetSeconds ?? 0) > 0 ? 'LANGUAGE: en' : GOOD;
    return { text, status: 'completed' };
  };
}

interface RunningService {
  base: string;
  logs: string[];
  server: Server;
  close: () => Promise<void>;
}

async function startService(
  calls: GeminiCall[],
  overrides: Partial<ServiceOptions> = {},
): Promise<RunningService> {
  const logs: string[] = [];
  const server: Server = createService({
    callerFactory: doubleFactory(calls),
    model: 'test-model',
    maxBlockSeconds: 8,
    cacheDir: mkdtempSync(join(tmpdir(), 'fa-svc-cache-')),
    log: (line) => logs.push(line),
    ...overrides,
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    logs,
    server,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

interface HttpResult {
  status: number;
  body: any;
}

async function postJob(
  base: string,
  opts: { url?: string; key?: string; token?: string; cfIp?: string; origin?: unknown; tenant?: unknown } = {},
): Promise<HttpResult> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.key !== undefined) headers['x-gemini-key'] = opts.key;
  if (opts.token !== undefined) headers['authorization'] = `Bearer ${opts.token}`;
  if (opts.cfIp !== undefined) headers['cf-connecting-ip'] = opts.cfIp;
  const res = await fetch(`${base}/v1/jobs`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      url: opts.url ?? `https://youtu.be/${VIDEO_A}`,
      ...(opts.origin !== undefined ? { origin: opts.origin } : {}),
      ...(opts.tenant !== undefined ? { tenant: opts.tenant } : {}),
    }),
  });
  return { status: res.status, body: await res.json() };
}

async function getJob(base: string, id: string, token?: string): Promise<HttpResult> {
  const headers = token === undefined ? {} : { authorization: `Bearer ${token}` };
  const res = await fetch(`${base}/v1/jobs/${id}`, { headers });
  return { status: res.status, body: await res.json() };
}

async function pollJob(base: string, id: string, token?: string): Promise<any> {
  for (let i = 0; i < 500; i++) {
    const { status, body } = await getJob(base, id, token);
    assert.equal(status, 200);
    if (body.status === 'done' || body.status === 'failed') return body;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.fail('job did not finish in time');
}

test('B1: POST then GET polls to done with the core transcript shape', async () => {
  const calls: GeminiCall[] = [];
  const { base, close } = await startService(calls);
  try {
    const res = await postJob(base, { key: KEY_A });
    assert.equal(res.status, 202);
    assert.equal(typeof res.body.job_id, 'string');

    const job = await pollJob(base, res.body.job_id);
    assert.equal(job.status, 'done');
    assert.equal(job.result.video_id, VIDEO_A);
    assert.equal(job.result.source_url, `https://www.youtube.com/watch?v=${VIDEO_A}`);
    assert.equal(job.result.language, 'en');
    assert.ok(Array.isArray(job.result.blocks));
    assert.ok(job.result.blocks.length > 0);
    assert.equal(typeof job.result.blocks[0].start, 'number');
    assert.equal(typeof job.result.blocks[0].end, 'number');
    assert.equal(typeof job.result.blocks[0].text, 'string');
    assert.ok(calls.length > 0);
  } finally {
    await close();
  }
});

test('B2: a second caller key hits the shared cache with zero Gemini calls', async () => {
  const calls: GeminiCall[] = [];
  const { base, close } = await startService(calls);
  try {
    const first = await postJob(base, { key: KEY_A });
    assert.equal((await pollJob(base, first.body.job_id)).status, 'done');
    const callsAfterFirst = calls.length;
    assert.ok(callsAfterFirst > 0);

    const second = await postJob(base, { key: KEY_B });
    assert.equal(second.status, 202);
    const job = await pollJob(base, second.body.job_id);
    assert.equal(job.status, 'done');
    assert.equal(job.result.video_id, VIDEO_A);
    assert.equal(calls.length, callsAfterFirst);
  } finally {
    await close();
  }
});

test('B3: a POST without X-Gemini-Key is 400 missing_key; a rejected key fails the job', async () => {
  const calls: GeminiCall[] = [];
  const { base, close } = await startService(calls, {
    callerFactory: doubleFactory(
      calls,
      new Map([[KEY_A, new TranscriptError('key_rejected', 'Gemini rejected the API key')]]),
    ),
  });
  try {
    const keyless = await postJob(base, {});
    assert.equal(keyless.status, 400);
    assert.equal(keyless.body.error.code, 'missing_key');

    const res = await postJob(base, { key: KEY_A });
    assert.equal(res.status, 202);
    const job = await pollJob(base, res.body.job_id);
    assert.equal(job.status, 'failed');
    assert.equal(job.error.code, 'key_rejected');
  } finally {
    await close();
  }
});

test('B4: SERVICE_TOKEN gates /v1 but not /healthz', async () => {
  const calls: GeminiCall[] = [];
  const { base, logs, close } = await startService(calls, { serviceToken: 'tok-secret' });
  try {
    const health = await fetch(`${base}/healthz`);
    assert.equal(health.status, 200);

    assert.equal((await postJob(base, { key: KEY_A })).status, 401);
    assert.equal((await postJob(base, { key: KEY_A, token: 'wrong-tok' })).status, 401);
    assert.equal((await postJob(base, { key: KEY_A, token: 'tok-secret' })).status, 202);
    assert.equal((await getJob(base, 'whatever')).status, 401);

    // A bearer with non-ASCII bytes has a different UTF-8 byte length; it must
    // be a plain 401, never a 500 from a thrown comparison.
    const port = Number(new URL(base).port);
    const raw = await new Promise<string>((resolve, reject) => {
      const socket = createConnection({ host: '127.0.0.1', port }, () =>
        socket.write(
          Buffer.from(
            'GET /v1/jobs/unknown HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer tök-secret\r\nConnection: close\r\n\r\n',
            'latin1',
          ),
        ),
      );
      let data = '';
      socket.on('data', (chunk: Buffer) => (data += chunk.toString()));
      socket.on('end', () => resolve(data));
      socket.on('error', reject);
    });
    assert.ok(raw.startsWith('HTTP/1.1 401 '), `expected 401, got: ${raw}`);
    assert.ok(
      !logs.some((line) => line.includes('unhandled error')),
      `unhandled error logged: ${logs.join('\n')}`,
    );
  } finally {
    await close();
  }
});

test('B5: caller keys appear nowhere in logs, job records or responses', async () => {
  const calls: GeminiCall[] = [];
  const { base, logs, close } = await startService(calls, {
    callerFactory: doubleFactory(
      calls,
      // The double even echoes the key in its error message to prove redaction.
      new Map([[KEY_B, new TranscriptError('key_rejected', `bad key ${KEY_B} rejected`)]]),
    ),
  });
  try {
    const bodies: string[] = [];
    const okJob = await postJob(base, { key: KEY_A });
    bodies.push(JSON.stringify(okJob.body));
    bodies.push(JSON.stringify(await pollJob(base, okJob.body.job_id)));

    const failJob = await postJob(base, { url: `https://youtu.be/${VIDEO_B}`, key: KEY_B });
    bodies.push(JSON.stringify(failJob.body));
    bodies.push(JSON.stringify(await pollJob(base, failJob.body.job_id)));

    bodies.push(JSON.stringify((await postJob(base, {})).body));
    bodies.push(JSON.stringify((await getJob(base, 'no-such-job')).body));

    // A key embedded in request input must not come back in errors or logs.
    const badUrl = await postJob(base, {
      url: `https://example.com/watch?key=${KEY_A}`,
      key: KEY_A,
    });
    bodies.push(JSON.stringify(badUrl.body));
    assert.equal(badUrl.body.error.code, 'invalid_url');
    const pathProbe = await fetch(`${base}/v1/jobs/${KEY_A}`, {
      headers: { 'x-gemini-key': KEY_A },
    });
    bodies.push(await pathProbe.text());

    const haystack = `${logs.join('\n')}\n${bodies.join('\n')}`;
    assert.ok(!haystack.includes(KEY_A), `key A leaked into: ${haystack}`);
    assert.ok(!haystack.includes(KEY_B), `key B leaked into: ${haystack}`);
  } finally {
    await close();
  }
});

test('B6: two concurrent jobs keep results and keys on their own job', async () => {
  const calls: GeminiCall[] = [];
  const { base, close } = await startService(calls);
  try {
    const [a, b] = await Promise.all([
      postJob(base, { url: `https://youtu.be/${VIDEO_A}`, key: KEY_A }),
      postJob(base, { url: `https://youtu.be/${VIDEO_B}`, key: KEY_B }),
    ]);
    assert.equal(a.status, 202);
    assert.equal(b.status, 202);
    const [jobA, jobB] = await Promise.all([
      pollJob(base, a.body.job_id),
      pollJob(base, b.body.job_id),
    ]);
    assert.equal(jobA.status, 'done');
    assert.equal(jobB.status, 'done');
    assert.equal(jobA.result.video_id, VIDEO_A);
    assert.equal(jobB.result.video_id, VIDEO_B);

    const keysFor = (videoId: string) =>
      new Set(calls.filter((c) => c.req.videoUrl.includes(videoId)).map((c) => c.apiKey));
    assert.deepEqual([...keysFor(VIDEO_A)], [KEY_A]);
    assert.deepEqual([...keysFor(VIDEO_B)], [KEY_B]);
  } finally {
    await close();
  }
});

// --- Issue 43: per-client limits on the anonymous surface -------------

test('L1: the per-client hourly cap rejects with 429 rate_limited', async () => {
  const calls: GeminiCall[] = [];
  const { base, close } = await startService(calls, { maxJobsPerHourPerClient: 2 });
  try {
    const first = await postJob(base, { key: KEY_A });
    assert.equal(first.status, 202);
    await pollJob(base, first.body.job_id);
    const second = await postJob(base, { key: KEY_A });
    assert.equal(second.status, 202);
    await pollJob(base, second.body.job_id);

    const third = await postJob(base, { key: KEY_A });
    assert.equal(third.status, 429);
    assert.equal(third.body.error.code, 'rate_limited');
    assert.equal(third.body.error.message, 'too many jobs in the last hour — try again later');

    // A different client is unaffected, and /healthz and job polling are
    // never limited.
    const other = await postJob(base, { key: KEY_A, cfIp: '203.0.113.5' });
    assert.equal(other.status, 202);
    assert.equal((await fetch(`${base}/healthz`)).status, 200);
    assert.equal((await getJob(base, first.body.job_id)).status, 200);
  } finally {
    await close();
  }
});

test('L2: the per-client concurrency cap rejects while a job is in flight', async () => {
  const calls: GeminiCall[] = [];
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  const { base, close } = await startService(calls, {
    maxConcurrentJobsPerClient: 1,
    maxJobsPerHourPerClient: 50,
    callerFactory: (apiKey) => async (req) => {
      calls.push({ apiKey, req });
      await gate;
      const text = (req.startOffsetSeconds ?? 0) > 0 ? 'LANGUAGE: en' : GOOD;
      return { text, status: 'completed' };
    },
  });
  try {
    const first = await postJob(base, { key: KEY_A });
    assert.equal(first.status, 202);

    // The first job is still in flight: this client's next submission is
    // over the concurrency cap and no job is created.
    const blocked = await postJob(base, { key: KEY_A });
    assert.equal(blocked.status, 429);
    assert.equal(blocked.body.error.code, 'rate_limited');

    release();
    assert.equal((await pollJob(base, first.body.job_id)).status, 'done');

    // The finished job's slot is back: the same client can submit again.
    const next = await postJob(base, { key: KEY_A });
    assert.equal(next.status, 202);
    await pollJob(base, next.body.job_id);
  } finally {
    await close();
  }
});

test('L3: a trusted peer keys jobs on CF-Connecting-IP, an untrusted one on its address', async () => {
  const calls: GeminiCall[] = [];
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  const blockedCaller = (apiKey: string): GeminiCaller => {
    return async (req) => {
      calls.push({ apiKey, req });
      await gate;
      const text = (req.startOffsetSeconds ?? 0) > 0 ? 'LANGUAGE: en' : GOOD;
      return { text, status: 'completed' };
    };
  };
  // Trusted: the test peer 127.0.0.1 IS in the trusted list — the header
  // names the client bucket.
  const { base, close } = await startService(calls, {
    maxConcurrentJobsPerClient: 1,
    maxJobsPerHourPerClient: 50,
    trustedProxies: ['127.0.0.1'],
    callerFactory: blockedCaller,
  });
  try {
    const first = await postJob(base, { key: KEY_A });
    assert.equal(first.status, 202);
    // Same socket client: over the concurrency cap.
    assert.equal((await postJob(base, { key: KEY_A })).status, 429);
    // A tunneled request naming another client gets its own bucket.
    const other = await postJob(base, { key: KEY_A, cfIp: '203.0.113.5' });
    assert.equal(other.status, 202);
    // That bucket fills too, and a non-IP header value falls back to the
    // socket address — still over the cap.
    assert.equal((await postJob(base, { key: KEY_A, cfIp: '203.0.113.5' })).status, 429);
    assert.equal((await postJob(base, { key: KEY_A, cfIp: 'bogus' })).status, 429);
    release();
    await pollJob(base, first.body.job_id);
    await pollJob(base, other.body.job_id);
  } finally {
    await close();
  }
});

test('L4: a forged CF-Connecting-IP header from an untrusted peer is ignored', async () => {
  const calls: GeminiCall[] = [];
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  const { base, close } = await startService(calls, {
    maxConcurrentJobsPerClient: 1,
    maxJobsPerHourPerClient: 50,
    // The connector lives somewhere else: the test peer 127.0.0.1 is not
    // trusted, so its header is caller-controlled text and ignored.
    trustedProxies: ['10.99.0.1'],
    callerFactory: (apiKey) => async (req) => {
      calls.push({ apiKey, req });
      await gate;
      const text = (req.startOffsetSeconds ?? 0) > 0 ? 'LANGUAGE: en' : GOOD;
      return { text, status: 'completed' };
    },
  });
  try {
    assert.equal((await postJob(base, { key: KEY_A })).status, 202);
    const forged = await postJob(base, { key: KEY_A, cfIp: '198.51.100.9' });
    assert.equal(forged.status, 429);
    assert.equal(forged.body.error.code, 'rate_limited');
    release();
  } finally {
    await close();
  }
});

test('L5: with SERVICE_TOKEN set the authenticated surface has no per-client limit', async () => {
  const calls: GeminiCall[] = [];
  const { base, close } = await startService(calls, {
    serviceToken: 'tok-secret',
    maxJobsPerHourPerClient: 1,
    maxConcurrentJobsPerClient: 1,
  });
  try {
    for (let i = 0; i < 3; i++) {
      const res = await postJob(base, { key: KEY_A, token: 'tok-secret' });
      assert.equal(res.status, 202);
      await pollJob(base, res.body.job_id, 'tok-secret');
    }
  } finally {
    await close();
  }
});

// Sends `n` job posts whose headers all reach the service before any
// body does — the race the per-client check must still hold: every
// request is past header parsing while none has finished validating.
async function raceSubmits(server: Server, base: string, n: number): Promise<number[]> {
  let seen = 0;
  const allSeen = new Promise<void>((resolve) => {
    server.on('request', () => {
      if (++seen === n) resolve();
    });
  });
  const body = JSON.stringify({ url: `https://youtu.be/${VIDEO_A}` });
  const port = Number(new URL(base).port);
  const pending: ClientRequest[] = [];
  const statuses = Array.from(
    { length: n },
    () =>
      new Promise<number>((resolve, reject) => {
        const req = request(
          {
            host: '127.0.0.1',
            port,
            path: '/v1/jobs',
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'content-length': Buffer.byteLength(body),
              'x-gemini-key': KEY_A,
            },
          },
          (res) => {
            res.resume();
            res.on('end', () => resolve(res.statusCode ?? 0));
          },
        );
        req.on('error', reject);
        pending.push(req);
        req.flushHeaders();
      }),
  );
  await allSeen;
  for (const req of pending) req.end(body);
  return Promise.all(statuses);
}

test('L6: eight racing requests cannot pass the concurrency cap', async () => {
  const calls: GeminiCall[] = [];
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  const { base, server, close } = await startService(calls, {
    maxConcurrentJobsPerClient: 1,
    maxJobsPerHourPerClient: 100,
    callerFactory: () => async () => {
      await gate;
      throw new TranscriptError('video_unavailable', 'offline');
    },
  });
  try {
    const statuses = await raceSubmits(server, base, 8);
    assert.equal(statuses.filter((s) => s === 202).length, 1, statuses.join(','));
    assert.equal(statuses.filter((s) => s === 429).length, 7, statuses.join(','));
  } finally {
    release();
    await close();
  }
});

test('L7: eight racing requests cannot pass the hourly cap', async () => {
  const calls: GeminiCall[] = [];
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  const { base, server, close } = await startService(calls, {
    maxConcurrentJobsPerClient: 100,
    maxJobsPerHourPerClient: 1,
    callerFactory: () => async () => {
      await gate;
      throw new TranscriptError('video_unavailable', 'offline');
    },
  });
  try {
    const statuses = await raceSubmits(server, base, 8);
    assert.equal(statuses.filter((s) => s === 202).length, 1, statuses.join(','));
    assert.equal(statuses.filter((s) => s === 429).length, 7, statuses.join(','));
  } finally {
    release();
    await close();
  }
});

test('L8: a rejected request consumes neither cap allowance', async () => {
  const calls: GeminiCall[] = [];
  const { base, close } = await startService(calls, {
    maxConcurrentJobsPerClient: 1,
    maxJobsPerHourPerClient: 1,
  });
  try {
    // Two rejections after booking — a bad URL and a missing key — hand
    // their slots back, so the cap of one still admits a good submit.
    const badUrl = await postJob(base, { url: 'https://example.com/x', key: KEY_A });
    assert.equal(badUrl.status, 400);
    const keyless = await postJob(base, {});
    assert.equal(keyless.status, 400);

    const good = await postJob(base, { key: KEY_A });
    assert.equal(good.status, 202);
    await pollJob(base, good.body.job_id);

    // The accepted submit did spend the allowance: the next one is 429.
    const limited = await postJob(base, { key: KEY_A });
    assert.equal(limited.status, 429);
    assert.equal(limited.body.error.code, 'rate_limited');
  } finally {
    await close();
  }
});

test('unknown routes and bad input get JSON errors', async () => {
  const calls: GeminiCall[] = [];
  const { base, close } = await startService(calls);
  try {
    assert.equal((await fetch(`${base}/nope`)).status, 404);
    assert.equal((await getJob(base, 'no-such-job')).status, 404);

    const badUrl = await postJob(base, { url: 'https://example.com/x', key: KEY_A });
    assert.equal(badUrl.status, 400);
    assert.equal(badUrl.body.error.code, 'invalid_url');

    const badJson = await fetch(`${base}/v1/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-gemini-key': KEY_A },
      body: 'not json',
    });
    assert.equal(badJson.status, 400);
    assert.equal((await badJson.json()).error.code, 'invalid_request');
  } finally {
    await close();
  }
});

// Issue #42: the web page's save-time key check reads the configured model.
// Issue #46: the page footer reads the build identity; a service built
// without version args reports the dev defaults.
test('GET /v1/config returns the configured model and build identity', async () => {
  const calls: GeminiCall[] = [];
  const { base, logs, close } = await startService(calls);
  try {
    const res = await fetch(`${base}/v1/config`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
      model: 'test-model',
      version: '0.0.0-dev',
      commit: 'unknown',
    });
    assert.ok(
      logs.some((line) => line.includes('route=GET /v1/config')),
      `config route missing from logs: ${logs.join('\n')}`,
    );
  } finally {
    await close();
  }
});

test('GET /v1/config reports the version and commit the service was built with', async () => {
  const calls: GeminiCall[] = [];
  const { base, close } = await startService(calls, {
    version: 'v0.1.0',
    commit: '011b7680d9a2c1f4a5b6c7d8e9f0a1b2c3d4e5f6',
  });
  try {
    const res = await fetch(`${base}/v1/config`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
      model: 'test-model',
      version: 'v0.1.0',
      commit: '011b7680d9a2c1f4a5b6c7d8e9f0a1b2c3d4e5f6',
    });
  } finally {
    await close();
  }
});

// --- allen-ai-os#1511: a tenant may hold the Gemini key its callers spend ---

const TENANT_KEY = 'TEST-KEY-TENANT-z7z7z7';
const CALLER_TOKEN = 'test-caller-token-tenant';
const TENANT_KEY_ENV = 'FA_TEST_TENANT_GEMINI_KEY';
const TENANT_UNSET_ENV = 'FA_TEST_TENANT_GEMINI_UNSET';

const callerSha = (token: string): string =>
  createHash('sha256').update(token).digest('hex');

// 'keyed' holds a Gemini key its verified callers may spend, 'unset' names
// one whose variable is never set, and 'plain' has no key field at all.
const TENANTS_KEYED = JSON.stringify({
  tenants: [
    {
      id: 'keyed',
      discord_guild_id: 'guild-k',
      caller: { token_sha256: callerSha(CALLER_TOKEN) },
      gemini_key_env: TENANT_KEY_ENV,
      destination: { type: 'none' },
    },
    {
      id: 'unset',
      discord_guild_id: 'guild-u',
      caller: { token_sha256: callerSha(CALLER_TOKEN) },
      gemini_key_env: TENANT_UNSET_ENV,
      destination: { type: 'none' },
    },
    {
      id: 'plain',
      discord_guild_id: 'guild-p',
      caller: { token_sha256: callerSha(CALLER_TOKEN) },
      destination: { type: 'none' },
    },
  ],
});

const KEYED_ORIGIN = { kind: 'discord', guild_id: 'guild-k', channel_id: 'chan-1' };

test('K1: a verified tenant caller without X-Gemini-Key transcribes on the tenant key', async () => {
  const calls: GeminiCall[] = [];
  process.env[TENANT_KEY_ENV] = TENANT_KEY;
  const { base, logs, close } = await startService(calls, { tenantsJson: TENANTS_KEYED });
  try {
    const res = await postJob(base, { origin: KEYED_ORIGIN, token: CALLER_TOKEN });
    assert.equal(res.status, 202);
    const job = await pollJob(base, res.body.job_id);
    assert.equal(job.status, 'done');
    assert.equal(job.result.video_id, VIDEO_A);
    assert.ok(calls.length > 0);
    assert.deepEqual([...new Set(calls.map((c) => c.apiKey))], [TENANT_KEY]);

    // The tenant key reaches nothing but the Gemini client: not the
    // response, the job view or the logs.
    const haystack = `${logs.join('\n')}\n${JSON.stringify(res.body)}\n${JSON.stringify(job)}`;
    assert.ok(!haystack.includes(TENANT_KEY), `tenant key leaked into: ${haystack}`);
  } finally {
    delete process.env[TENANT_KEY_ENV];
    await close();
  }
});

test('K2: a keyless request whose caller check fails, or matches no tenant, never spends the tenant key', async () => {
  const calls: GeminiCall[] = [];
  process.env[TENANT_KEY_ENV] = TENANT_KEY;
  const { base, close } = await startService(calls, { tenantsJson: TENANTS_KEYED });
  try {
    for (const token of [undefined, 'wrong-token']) {
      const res = await postJob(base, {
        origin: KEYED_ORIGIN,
        ...(token === undefined ? {} : { token }),
      });
      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, 'missing_key');
    }
    // A claim that matches no tenant resolves no key either.
    const unmatched = await postJob(base, {
      origin: { kind: 'discord', guild_id: 'stranger', channel_id: 'chan-9' },
      token: CALLER_TOKEN,
    });
    assert.equal(unmatched.status, 400);
    assert.equal(unmatched.body.error.code, 'missing_key');
    assert.equal(calls.length, 0, 'an unverified claim must not reach Gemini');
  } finally {
    delete process.env[TENANT_KEY_ENV];
    await close();
  }
});

test('K3: X-Gemini-Key wins over the tenant key; a denied claim still reports save_unauthorized', async () => {
  const calls: GeminiCall[] = [];
  process.env[TENANT_KEY_ENV] = TENANT_KEY;
  const { base, close } = await startService(calls, { tenantsJson: TENANTS_KEYED });
  try {
    // BYOK with a verified claim spends the caller's own key, not the tenant's.
    const byok = await postJob(base, { key: KEY_A, origin: KEYED_ORIGIN, token: CALLER_TOKEN });
    assert.equal(byok.status, 202);
    assert.equal((await pollJob(base, byok.body.job_id)).status, 'done');

    // BYOK with a wrong token still runs on the caller's key and the save
    // is denied — today's behavior, unchanged.
    const denied = await postJob(base, { key: KEY_A, origin: KEYED_ORIGIN, token: 'wrong-token' });
    assert.equal(denied.status, 202);
    const job = await pollJob(base, denied.body.job_id);
    assert.equal(job.status, 'done');
    assert.equal(job.save_error.code, 'save_unauthorized');

    assert.deepEqual([...new Set(calls.map((c) => c.apiKey))], [KEY_A]);
  } finally {
    delete process.env[TENANT_KEY_ENV];
    await close();
  }
});

test('K4: a tenant without the field, or with its variable unset, still needs X-Gemini-Key', async () => {
  const calls: GeminiCall[] = [];
  process.env[TENANT_KEY_ENV] = TENANT_KEY;
  delete process.env[TENANT_UNSET_ENV];
  const { base, close } = await startService(calls, { tenantsJson: TENANTS_KEYED });
  try {
    const plain = await postJob(base, {
      origin: { kind: 'discord', guild_id: 'guild-p', channel_id: 'chan-1' },
      token: CALLER_TOKEN,
    });
    assert.equal(plain.status, 400);
    assert.equal(plain.body.error.code, 'missing_key');

    // A verified caller whose tenant names a variable that holds nothing
    // gets the same fixed missing_key — never a crash or a half-key.
    const unset = await postJob(base, {
      origin: { kind: 'discord', guild_id: 'guild-u', channel_id: 'chan-1' },
      token: CALLER_TOKEN,
    });
    assert.equal(unset.status, 400);
    assert.equal(unset.body.error.code, 'missing_key');
    assert.equal(calls.length, 0);
  } finally {
    delete process.env[TENANT_KEY_ENV];
    await close();
  }
});

test('K6: a keyless request naming its tenant with the matching bearer spends the tenant key', async () => {
  const calls: GeminiCall[] = [];
  process.env[TENANT_KEY_ENV] = TENANT_KEY;
  const { base, logs, close } = await startService(calls, { tenantsJson: TENANTS_KEYED });
  try {
    const res = await postJob(base, { tenant: 'keyed', token: CALLER_TOKEN });
    assert.equal(res.status, 202);
    const job = await pollJob(base, res.body.job_id);
    assert.equal(job.status, 'done');
    assert.ok(calls.length > 0);
    assert.deepEqual([...new Set(calls.map((c) => c.apiKey))], [TENANT_KEY]);
    const haystack = `${logs.join('\n')}\n${JSON.stringify(res.body)}\n${JSON.stringify(job)}`;
    assert.ok(!haystack.includes(TENANT_KEY), 'tenant key leaked');
    // The leak check can fail: a seeded known value is caught.
    assert.ok(`${haystack} ${TENANT_KEY}`.includes(TENANT_KEY));
  } finally {
    delete process.env[TENANT_KEY_ENV];
    await close();
  }
});

test('K7: a named tenant with a wrong or missing bearer, or an unknown id, never spends the tenant key', async () => {
  const calls: GeminiCall[] = [];
  process.env[TENANT_KEY_ENV] = TENANT_KEY;
  const { base, close } = await startService(calls, { tenantsJson: TENANTS_KEYED });
  try {
    for (const opts of [
      { tenant: 'keyed', token: 'wrong-token' },
      { tenant: 'keyed' },
      { tenant: 'stranger', token: CALLER_TOKEN },
      { tenant: 'plain', token: CALLER_TOKEN },
    ]) {
      const res = await postJob(base, opts);
      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, 'missing_key');
    }
    // A malformed tenant is a plain bad request.
    const bad = await postJob(base, { tenant: 7, token: CALLER_TOKEN });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error.code, 'invalid_request');
    assert.equal(calls.length, 0);
  } finally {
    delete process.env[TENANT_KEY_ENV];
    await close();
  }
});

test('K5: a rejected tenant key fails the job and still never reaches logs, views or errors', async () => {
  const calls: GeminiCall[] = [];
  process.env[TENANT_KEY_ENV] = TENANT_KEY;
  const { base, logs, close } = await startService(calls, {
    tenantsJson: TENANTS_KEYED,
    callerFactory: doubleFactory(
      calls,
      // The double even echoes the key in its error message to prove redaction.
      new Map([[TENANT_KEY, new TranscriptError('key_rejected', `bad key ${TENANT_KEY} rejected`)]]),
    ),
  });
  try {
    const res = await postJob(base, { origin: KEYED_ORIGIN, token: CALLER_TOKEN });
    assert.equal(res.status, 202);
    const job = await pollJob(base, res.body.job_id);
    assert.equal(job.status, 'failed');
    assert.equal(job.error.code, 'key_rejected');

    const keyless = await postJob(base, { origin: KEYED_ORIGIN, token: 'wrong-token' });
    const haystack = `${logs.join('\n')}\n${JSON.stringify(job)}\n${JSON.stringify(keyless.body)}`;
    assert.ok(!haystack.includes(TENANT_KEY), `tenant key leaked into: ${haystack}`);
  } finally {
    delete process.env[TENANT_KEY_ENV];
    await close();
  }
});

// --- T2 (agentfleet-team/fisheraiagent#69): the per-tenant captions policy ---

const CAPTIONS_CALLER = 'test-caller-token-captions';

// Three tenants, one per policy value plus one without the field, all
// caller-verified through the same bearer token.
const TENANTS_CAPTIONS = JSON.stringify({
  tenants: [
    {
      id: 'cap-auto',
      discord_guild_id: 'guild-auto',
      caller: { token_sha256: callerSha(CAPTIONS_CALLER) },
      captions: 'manual-or-auto',
      destination: { type: 'none' },
    },
    {
      id: 'cap-off',
      discord_guild_id: 'guild-off',
      caller: { token_sha256: callerSha(CAPTIONS_CALLER) },
      captions: 'off',
      destination: { type: 'none' },
    },
    {
      id: 'cap-default',
      discord_guild_id: 'guild-def',
      caller: { token_sha256: callerSha(CAPTIONS_CALLER) },
      destination: { type: 'none' },
    },
  ],
});

const AUTO_READ: CaptionRead = {
  kind: 'auto',
  language: 'en',
  durationSeconds: 16,
  cues: [
    { start: 0, end: 8, text: 'auto one' },
    { start: 8, end: 16, text: 'auto two' },
  ],
};

const guildOrigin = (guild: string) => ({ kind: 'discord', guild_id: guild, channel_id: 'chan-1' });

function countingReader(reads: { n: number }, read: CaptionRead) {
  return async (): Promise<CaptionRead> => {
    reads.n += 1;
    return read;
  };
}

test('C1: a manual-or-auto tenant gets source captions:auto from an auto read with zero Gemini calls', async () => {
  const calls: GeminiCall[] = [];
  const reads = { n: 0 };
  const { base, logs, close } = await startService(calls, {
    tenantsJson: TENANTS_CAPTIONS,
    captionReader: countingReader(reads, AUTO_READ),
  });
  try {
    const res = await postJob(base, { key: KEY_A, origin: guildOrigin('guild-auto'), token: CAPTIONS_CALLER });
    assert.equal(res.status, 202);
    const job = await pollJob(base, res.body.job_id);
    assert.equal(job.status, 'done');
    assert.equal(job.result.source, 'captions:auto');
    assert.equal(reads.n, 1);
    assert.equal(calls.length, 0, 'an accepted auto track spends no Gemini call');
    assert.ok(logs.some((l) => l.startsWith('source_chosen') && l.includes('source=captions:auto')));
  } finally {
    await close();
  }
});

test('C2: an off tenant never reaches the reader — the job goes to Gemini', async () => {
  const calls: GeminiCall[] = [];
  const reads = { n: 0 };
  const { base, logs, close } = await startService(calls, {
    tenantsJson: TENANTS_CAPTIONS,
    captionReader: countingReader(reads, AUTO_READ),
  });
  try {
    const res = await postJob(base, { key: KEY_A, origin: guildOrigin('guild-off'), token: CAPTIONS_CALLER });
    assert.equal(res.status, 202);
    const job = await pollJob(base, res.body.job_id);
    assert.equal(job.status, 'done');
    assert.equal(job.result.source, 'gemini');
    assert.equal(reads.n, 0, 'policy off must skip the caption read');
    assert.ok(calls.length > 0, 'the Gemini path runs');
    assert.ok(logs.some((l) => l.startsWith('captions_skipped') && l.includes('policy=off')));
    assert.ok(!logs.some((l) => l.startsWith('captions_read')), 'a skipped read logs no captions_read');
  } finally {
    await close();
  }
});

test('C3: a tenant without the field, and a job with no tenant, keep the default manual policy', async () => {
  const calls: GeminiCall[] = [];
  const reads = { n: 0 };
  const { base, close } = await startService(calls, {
    tenantsJson: TENANTS_CAPTIONS,
    captionReader: countingReader(reads, AUTO_READ),
  });
  try {
    const tenanted = await postJob(base, { key: KEY_A, origin: guildOrigin('guild-def'), token: CAPTIONS_CALLER });
    const j1 = await pollJob(base, tenanted.body.job_id);
    assert.equal(j1.status, 'done');
    assert.equal(j1.result.source, 'gemini', 'absent field: an auto read still falls back (T1)');

    // A different video: a cache hit would skip the read before any policy.
    const anonymous = await postJob(base, { key: KEY_A, url: `https://youtu.be/${VIDEO_B}` });
    const j2 = await pollJob(base, anonymous.body.job_id);
    assert.equal(j2.status, 'done');
    assert.equal(j2.result.source, 'gemini', 'a job with no tenant uses the default');
    assert.equal(reads.n, 2, 'the read still runs under the default policy');
  } finally {
    await close();
  }
});

test('C4: a tenants document with an unknown captions value fails submits with invalid_config', async () => {
  const calls: GeminiCall[] = [];
  const reads = { n: 0 };
  const broken = JSON.stringify({
    tenants: [
      {
        id: 'cap-auto',
        discord_guild_id: 'guild-auto',
        caller: { token_sha256: callerSha(CAPTIONS_CALLER) },
        captions: 'auto',
        destination: { type: 'none' },
      },
    ],
  });
  const { base, close } = await startService(calls, {
    tenantsJson: broken,
    captionReader: countingReader(reads, AUTO_READ),
  });
  try {
    // The document cannot load, so no job may be submitted at all — a
    // claimed origin or an anonymous BYOK request alike gets the fixed
    // config error, and nothing transcribes on a silently tenantless guess.
    for (const opts of [
      { key: KEY_A, origin: guildOrigin('guild-auto'), token: CAPTIONS_CALLER },
      { key: KEY_A },
    ]) {
      const res = await postJob(base, opts);
      assert.equal(res.status, 500);
      assert.equal(res.body.error.code, 'invalid_config');
      assert.equal(res.body.error.message, 'the service configuration is invalid');
      assert.equal(res.body.job_id, undefined, 'no job is created under a broken tenants document');
    }
    assert.equal(reads.n, 0, 'no caption read may run under a broken tenants document');
    assert.equal(calls.length, 0, 'no Gemini call may run under a broken tenants document');
  } finally {
    await close();
  }
});
