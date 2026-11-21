import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createService, type ServiceOptions } from '../src/service.js';
import { TranscriptError } from '../src/errors.js';
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
    return { text: GOOD, status: 'completed' };
  };
}

interface RunningService {
  base: string;
  logs: string[];
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
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

interface HttpResult {
  status: number;
  body: any;
}

async function postJob(
  base: string,
  opts: { url?: string; key?: string; token?: string } = {},
): Promise<HttpResult> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.key !== undefined) headers['x-gemini-key'] = opts.key;
  if (opts.token !== undefined) headers['authorization'] = `Bearer ${opts.token}`;
  const res = await fetch(`${base}/v1/jobs`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ url: opts.url ?? `https://youtu.be/${VIDEO_A}` }),
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
  const { base, close } = await startService(calls, { serviceToken: 'tok-secret' });
  try {
    const health = await fetch(`${base}/healthz`);
    assert.equal(health.status, 200);

    assert.equal((await postJob(base, { key: KEY_A })).status, 401);
    assert.equal((await postJob(base, { key: KEY_A, token: 'wrong-tok' })).status, 401);
    assert.equal((await postJob(base, { key: KEY_A, token: 'tok-secret' })).status, 202);
    assert.equal((await getJob(base, 'whatever')).status, 401);
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
