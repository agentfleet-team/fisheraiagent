import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { createServer, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CaptionRead } from '../src/captions.js';
import { createRemoteCaptionReader, resolveCaptionReader } from '../src/captions-remote.js';
import { loadServiceConfig } from '../src/config.js';
import { TranscriptError } from '../src/errors.js';
import type { GeminiCaller, GeminiVideoRequest } from '../src/gemini.js';
import { JobStore, type JobView } from '../src/jobs.js';
import { transcribeYouTube, type TranscribeDeps } from '../src/transcribe.js';
import { freePort } from './fakes.js';

// The T1c/T1d contract (spec amendment r4): the cloud service calls the
// caption-reader tool at `GET <base>/v1/captions/<videoId>` with a bearer
// token, plus the Cloudflare Access service-token pair when the tunnel
// edge asks for it. Every test here runs the remote adapter against a
// fake reader on loopback — a real HTTP server, never YouTube.

const MANUAL_READ: CaptionRead = {
  kind: 'manual',
  language: 'zh-TW',
  durationSeconds: 24,
  cues: [
    { start: 0, end: 4, text: '第一句' },
    { start: 4, end: 8, text: '第二句' },
    { start: 8, end: 16, text: '第三句' },
  ],
};

const EMPTY = 'LANGUAGE: en';
const ONE_BLOCK = 'LANGUAGE: en\n[00:00 - 00:08] spoken words.';

interface SeenRequest {
  method?: string;
  url?: string;
  authorization?: string;
  accessId?: string;
  accessSecret?: string;
}

interface FakeReader {
  baseUrl: string;
  seen: SeenRequest[];
  close(): Promise<void>;
}

const single = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);

async function fakeReader(respond: (res: ServerResponse) => void): Promise<FakeReader> {
  const seen: SeenRequest[] = [];
  const server = createServer((req, res) => {
    // A timed-out client destroys the socket before a slow responder
    // writes; the write error must not take the fake down with it.
    res.on('error', () => {});
    seen.push({
      method: req.method,
      url: req.url,
      authorization: req.headers.authorization,
      accessId: single(req.headers['cf-access-client-id']),
      accessSecret: single(req.headers['cf-access-client-secret']),
    });
    respond(res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no address');
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    seen,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

function geminiDouble(
  responses: Array<{ text?: string; status?: string; error?: unknown }>,
): { calls: GeminiVideoRequest[]; caller: GeminiCaller } {
  const calls: GeminiVideoRequest[] = [];
  const queue = [...responses];
  const caller: GeminiCaller = async (req) => {
    calls.push(req);
    const next = queue.shift();
    if (!next) throw new Error('gemini double exhausted');
    if (next.error) throw next.error;
    return { text: next.text ?? '', status: next.status ?? 'completed' };
  };
  return { calls, caller };
}

function deps(caller: GeminiCaller, captionReader: TranscribeDeps['captionReader']): TranscribeDeps {
  return {
    caller,
    model: 'test-model',
    maxBlockSeconds: 8,
    cacheDir: mkdtempSync(join(tmpdir(), 'fa-cache-')),
    captionReader,
    captionReadOrigin: 'remote',
  };
}

async function settled(jobs: JobStore, id: string): Promise<JobView> {
  for (;;) {
    const view = jobs.get(id);
    if (view !== undefined && (view.status === 'done' || view.status === 'failed')) return view;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

// --- The contract: 200 + valid CaptionRead flows through, with auth ---

test('a remote read returning manual gives a job with source captions:manual and zero Gemini calls, with the bearer and Access headers sent', async () => {
  const reader = await fakeReader((res) =>
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(MANUAL_READ)),
  );
  try {
    const { calls, caller } = geminiDouble([]);
    const logs: string[] = [];
    const jobs = new JobStore({
      callerFactory: () => caller,
      model: 'test-model',
      maxBlockSeconds: 8,
      cacheDir: mkdtempSync(join(tmpdir(), 'fa-cache-')),
      captionReader: createRemoteCaptionReader({
        baseUrl: reader.baseUrl,
        token: 'test-reader-token',
        accessId: 'test-access-id',
        accessSecret: 'test-access-secret',
      }),
      captionReadOrigin: 'remote',
      log: (line) => logs.push(line),
    });
    const view = await settled(jobs, jobs.submit('dQw4w9WgXcQ', 'unused-gemini-key'));
    assert.equal(view.status, 'done');
    assert.equal(view.result?.source, 'captions:manual');
    assert.equal(view.result?.language, 'zh-TW');
    assert.equal(calls.length, 0, 'a manual track must not spend a Gemini call');
    assert.equal(reader.seen.length, 1, 'exactly one read, no retry');
    const req = reader.seen[0];
    assert.equal(req.method, 'GET');
    assert.equal(req.url, '/v1/captions/dQw4w9WgXcQ');
    assert.equal(req.authorization, 'Bearer test-reader-token');
    assert.equal(req.accessId, 'test-access-id');
    assert.equal(req.accessSecret, 'test-access-secret');
    assert.ok(
      logs.some(
        (l) => l.startsWith('captions_read') && l.includes('origin=remote') && l.includes('kind=manual'),
      ),
      'captions_read must name the remote origin',
    );
    for (const line of logs) {
      assert.ok(!line.includes('test-reader-token'), 'the bearer token must never reach a log line');
      assert.ok(!line.includes('test-access-secret'), 'the Access secret must never reach a log line');
    }
  } finally {
    await reader.close();
  }
});

// --- Table-driven: every failure class falls back to Gemini with its mapped reason ---

test('every remote failure maps to its reason and the job still goes to Gemini', async () => {
  const ok = (body: unknown, status = 200) => (res: ServerResponse) =>
    res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  const cases: Array<{ name: string; reason: string; serve?: (res: ServerResponse) => void }> = [
    {
      name: 'sleeps past the timeout',
      reason: 'timeout',
      serve: (res) => {
        setTimeout(() => res.writeHead(200).end(JSON.stringify(MANUAL_READ)), 400);
      },
    },
    { name: 'connection refused', reason: 'unreachable' },
    { name: '401 unauthorized', reason: 'http', serve: ok({ error: 'unauthorized' }, 401) },
    { name: '429 busy', reason: 'http', serve: ok({ error: 'busy' }, 429) },
    { name: '500 upstream', reason: 'http', serve: ok('oops', 500) },
    { name: 'bad json', reason: 'parse', serve: (res) => res.writeHead(200).end('<html>not json</html>') },
    {
      name: 'valid json, wrong shape',
      reason: 'parse',
      serve: ok({ kind: 'manual', language: 'en' }),
    },
    {
      name: '200 reporting a YouTube-side failure passes through as is',
      reason: 'blocked',
      serve: ok({ kind: 'unavailable', reason: 'blocked' }),
    },
  ];
  for (const c of cases) {
    const reader = c.serve === undefined ? undefined : await fakeReader(c.serve);
    const baseUrl = reader?.baseUrl ?? `http://127.0.0.1:${await freePort()}`;
    try {
      const { calls, caller } = geminiDouble([{ text: ONE_BLOCK }, { text: EMPTY }]);
      const logs: string[] = [];
      const d = deps(caller, createRemoteCaptionReader({ baseUrl, token: 'test-token', timeoutMs: 60 }));
      d.log = (line) => logs.push(line);
      const t = await transcribeYouTube('hWe-j78vNpc', d);
      assert.equal(t.source, 'gemini', c.name);
      assert.equal(calls.length, 2, `${c.name}: the Gemini path runs exactly as today`);
      assert.ok(
        logs.some(
          (l) =>
            l.startsWith('captions_read') &&
            l.includes('kind=unavailable') &&
            l.includes(`reason=${c.reason}`),
        ),
        `${c.name}: captions_read must carry the mapped reason`,
      );
      assert.ok(
        logs.some((l) => l.startsWith('source_chosen') && l.includes('source=gemini') && l.includes(`reason=${c.reason}`)),
        `${c.name}: source_chosen must carry the mapped reason`,
      );
      for (const line of logs) assert.ok(!line.includes('test-token'), 'no secret in a log line');
    } finally {
      await reader?.close();
    }
  }
});

// --- N2 mode: remote when configured, local on request, off by default ---

test('mode off with no env resolves no reader; the injected fetch sees zero YouTube and zero reader calls', async () => {
  let fetchCalls = 0;
  const spyFetch: typeof fetch = async () => {
    fetchCalls += 1;
    return new Response('{}', { status: 200 });
  };
  const resolved = resolveCaptionReader(loadServiceConfig({}), { fetchImpl: spyFetch });
  assert.equal(resolved, undefined, 'the default is off: no reader, no YouTube call at all');
  const { calls, caller } = geminiDouble([{ text: ONE_BLOCK }, { text: EMPTY }]);
  const t = await transcribeYouTube('hWe-j78vNpc', {
    caller,
    model: 'test-model',
    maxBlockSeconds: 8,
    cacheDir: mkdtempSync(join(tmpdir(), 'fa-cache-')),
    captionReader: resolved?.reader,
  });
  assert.equal(t.source, 'gemini');
  assert.equal(calls.length, 2);
  assert.equal(fetchCalls, 0, 'mode off must not touch the network for captions');
});

test('CAPTIONS_READ=local resolves the in-process reader; a configured URL wins as remote', () => {
  const local = resolveCaptionReader(loadServiceConfig({ CAPTIONS_READ: 'local' }));
  assert.equal(local?.origin, 'local');
  const remote = resolveCaptionReader(
    loadServiceConfig({
      CAPTIONS_READ: 'local',
      CAPTIONS_READER_URL: 'https://captions.example.com',
      CAPTIONS_READER_TOKEN: 't',
    }),
  );
  assert.equal(remote?.origin, 'remote');
});

// --- Config load: the remote setup must be complete and https ---

test('a complete remote setup parses with the default timeout; overrides apply', () => {
  const config = loadServiceConfig({
    CAPTIONS_READER_URL: ' https://captions.example.com/ ',
    CAPTIONS_READER_TOKEN: 'tok',
    CAPTIONS_READER_ACCESS_ID: 'id',
    CAPTIONS_READER_ACCESS_SECRET: 'sec',
  });
  assert.equal(config.captionsReader?.url, 'https://captions.example.com/');
  assert.equal(config.captionsReader?.token, 'tok');
  assert.equal(config.captionsReader?.accessId, 'id');
  assert.equal(config.captionsReader?.accessSecret, 'sec');
  assert.equal(config.captionsReader?.timeoutMs, 4000);
  assert.equal(config.captionsRead, undefined);

  const custom = loadServiceConfig({
    CAPTIONS_READER_URL: 'https://captions.example.com',
    CAPTIONS_READER_TOKEN: 'tok',
    CAPTIONS_READER_TIMEOUT_MS: '1500',
    CAPTIONS_READ: ' local ',
  });
  assert.equal(custom.captionsReader?.timeoutMs, 1500);
  assert.equal(custom.captionsRead, 'local');

  assert.equal(loadServiceConfig({}).captionsReader, undefined);
  assert.equal(loadServiceConfig({}).captionsRead, undefined);
});

test('a non-https URL, a partial setup or a bad value fails config load', () => {
  const bad: Record<string, string>[] = [
    { CAPTIONS_READER_URL: 'http://captions.example.com', CAPTIONS_READER_TOKEN: 't' },
    { CAPTIONS_READER_URL: 'not-a-url', CAPTIONS_READER_TOKEN: 't' },
    { CAPTIONS_READER_URL: 'https://captions.example.com' },
    { CAPTIONS_READER_TOKEN: 't' },
    { CAPTIONS_READER_ACCESS_ID: 'id', CAPTIONS_READER_ACCESS_SECRET: 'sec' },
    {
      CAPTIONS_READER_URL: 'https://captions.example.com',
      CAPTIONS_READER_TOKEN: 't',
      CAPTIONS_READER_ACCESS_ID: 'id',
    },
    { CAPTIONS_READ: 'remote' },
    { CAPTIONS_READ: 'yes' },
    { CAPTIONS_READER_URL: 'https://captions.example.com', CAPTIONS_READER_TOKEN: 't', CAPTIONS_READER_TIMEOUT_MS: 'abc' },
    { CAPTIONS_READER_TIMEOUT_MS: '-5' },
  ];
  for (const env of bad) {
    assert.throws(
      () => loadServiceConfig(env),
      (err: unknown) => err instanceof TranscriptError && err.code === 'invalid_config',
      JSON.stringify(env),
    );
  }
});
