import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { createCaptionReader, type CaptionRead } from '../src/captions.js';
import { createCaptionReaderServer } from '../src/caption-reader-service.js';

// The caption-reader tool (agentfleet-team/fisheraiagent#78, spec amendment
// r4 on #65): the #76 reader behind GET /v1/captions/{videoId}. Every test
// runs the real HTTP server on a free port; only the YouTube fetch is a fake,
// fed with the T0 recordings, and it counts its calls.

const TOKEN = 'test-token-not-a-secret';
const FIXTURES = new URL('../spike/captions/fixtures/innertube-android/', import.meta.url);
const fixture = (videoId: string, name: string) =>
  readFileSync(new URL(`./${videoId}/${name}`, FIXTURES), 'utf8');

function fakeYouTube(videoId: string): { fetchImpl: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    calls.push(url);
    if (url.includes('youtubei/v1/player')) {
      try {
        return new Response(fixture(videoId, 'player.json'), { status: 200 });
      } catch {
        return new Response('nope', { status: 500 });
      }
    }
    const params = new URL(url).searchParams;
    const kind = params.get('kind') === 'asr' ? 'asr' : 'manual';
    try {
      return new Response(fixture(videoId, `${kind}.${params.get('lang') ?? ''}.json3`), { status: 200 });
    } catch {
      return new Response('no such track', { status: 404 });
    }
  };
  return { fetchImpl, calls };
}

const dirs: string[] = [];
const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'caption-reader-test-'));
  dirs.push(dir);
  return dir;
};
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

interface Harness {
  base: string;
  receiptDir: string;
  calls: string[];
  close: () => Promise<void>;
}

async function start(
  videoId: string,
  options: { maxConcurrent?: number; gate?: Promise<void> } = {},
): Promise<Harness> {
  const { fetchImpl, calls } = fakeYouTube(videoId);
  const gated: typeof fetch = async (input, init) => {
    if (options.gate) await options.gate;
    return fetchImpl(input, init);
  };
  const receiptDir = tmp();
  const server = createCaptionReaderServer({
    token: TOKEN,
    reader: createCaptionReader({ fetchImpl: options.gate ? gated : fetchImpl }),
    maxConcurrent: options.maxConcurrent ?? 4,
    receiptDir,
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    receiptDir,
    calls,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

const auth = (token = TOKEN) => ({ headers: { authorization: `Bearer ${token}` } });

function receipts(dir: string): Record<string, unknown>[] {
  return readdirSync(dir)
    .sort()
    .flatMap((f) => readFileSync(join(dir, f), 'utf8').split('\n').filter(Boolean))
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function expectedRead(videoId: string): Promise<CaptionRead> {
  return createCaptionReader({ fetchImpl: fakeYouTube(videoId).fetchImpl })(videoId);
}

test('a valid token returns the reader output: manual, auto, none and unavailable', async () => {
  for (const [videoId, kind, reason] of [
    ['dQw4w9WgXcQ', 'manual', undefined],
    ['hWe-j78vNpc', 'auto', undefined],
    ['aqz-KE-bpKQ', 'none', undefined],
    ['zzzzzzzzzzz', 'unavailable', 'http'],
  ] as const) {
    const h = await start(videoId);
    try {
      const res = await fetch(`${h.base}/v1/captions/${videoId}`, auth());
      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-type') ?? '', /^application\/json/);
      const body = (await res.json()) as CaptionRead;
      assert.equal(body.kind, kind);
      if (reason) assert.equal((body as { reason?: string }).reason, reason);
      assert.deepEqual(body, await expectedRead(videoId));
      assert.ok(h.calls.length > 0);
    } finally {
      await h.close();
    }
  }
});

test('a wrong or missing token is 401 and YouTube sees zero calls', async () => {
  const h = await start('dQw4w9WgXcQ');
  try {
    for (const init of [undefined, auth('wrong'), auth(''), { headers: { authorization: TOKEN } }, { headers: { authorization: `Basic ${TOKEN}` } }]) {
      const res = await fetch(`${h.base}/v1/captions/dQw4w9WgXcQ`, init);
      assert.equal(res.status, 401);
      assert.deepEqual(await res.json(), { error: 'unauthorized' });
    }
    assert.equal(h.calls.length, 0);
  } finally {
    await h.close();
  }
});

test('a bad video id is 400 and YouTube sees zero calls', async () => {
  const h = await start('dQw4w9WgXcQ');
  try {
    for (const id of ['short', 'dQw4w9WgXcQx', 'dQw4w9WgXc%2F', 'dQw4w9WgXc.']) {
      const res = await fetch(`${h.base}/v1/captions/${id}`, auth());
      assert.equal(res.status, 400, id);
      assert.deepEqual(await res.json(), { error: 'invalid_video_id' });
    }
    assert.equal(h.calls.length, 0);
  } finally {
    await h.close();
  }
});

test('over the concurrency cap is 429 busy, and the slot frees afterwards', async () => {
  let open!: () => void;
  const gate = new Promise<void>((r) => {
    open = r;
  });
  const h = await start('dQw4w9WgXcQ', { maxConcurrent: 1, gate });
  try {
    const first = fetch(`${h.base}/v1/captions/dQw4w9WgXcQ`, auth());
    await new Promise((r) => setTimeout(r, 100));
    const second = await fetch(`${h.base}/v1/captions/dQw4w9WgXcQ`, auth());
    assert.equal(second.status, 429);
    assert.deepEqual(await second.json(), { error: 'busy' });
    open();
    assert.equal((await first).status, 200);
    const third = await fetch(`${h.base}/v1/captions/dQw4w9WgXcQ`, auth());
    assert.equal(third.status, 200);
  } finally {
    open();
    await h.close();
  }
});

test('/healthz answers 200 ok, other paths 404', async () => {
  const h = await start('dQw4w9WgXcQ');
  try {
    const ok = await fetch(`${h.base}/healthz`);
    assert.equal(ok.status, 200);
    assert.equal(await ok.text(), 'ok');
    assert.equal((await fetch(`${h.base}/other`, auth())).status, 404);
    assert.equal((await fetch(`${h.base}/v1/captions/dQw4w9WgXcQ`, { ...auth(), method: 'POST' })).status, 404);
    assert.equal(h.calls.length, 0);
  } finally {
    await h.close();
  }
});

test('each captions request writes exactly one receipt with the r4 fields, never the token', async () => {
  const h = await start('dQw4w9WgXcQ');
  try {
    await fetch(`${h.base}/v1/captions/dQw4w9WgXcQ`, auth());
    await fetch(`${h.base}/v1/captions/dQw4w9WgXcQ`, auth('wrong-token-value'));
    await fetch(`${h.base}/v1/captions/bad`, auth());
    await fetch(`${h.base}/healthz`);
    const lines = receipts(h.receiptDir);
    assert.equal(lines.length, 3);

    const read = await expectedRead('dQw4w9WgXcQ');
    assert.equal(read.kind, 'manual');
    const ok = lines[0];
    assert.deepEqual(Object.keys(ok).sort(), ['caller', 'cue_count', 'cues_sha256', 'kind', 'language', 'ms', 'reason', 'status', 'ts', 'video_id']);
    assert.match(String(ok.ts), /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/);
    assert.equal(ok.video_id, 'dQw4w9WgXcQ');
    assert.equal(ok.status, 200);
    assert.equal(ok.kind, 'manual');
    assert.equal(ok.reason, null);
    assert.equal(ok.language, 'en');
    assert.equal(ok.cue_count, read.kind === 'manual' ? read.cues.length : -1);
    assert.equal(ok.cues_sha256, createHash('sha256').update(JSON.stringify((read as { cues: unknown }).cues)).digest('hex'));
    assert.equal(typeof ok.ms, 'number');
    assert.equal(ok.caller, createHash('sha256').update(TOKEN).digest('hex').slice(0, 8));

    assert.equal(lines[1].status, 401);
    assert.equal(lines[1].caller, null);
    assert.equal(lines[2].status, 400);
    assert.equal(lines[2].caller, ok.caller);

    const raw = readdirSync(h.receiptDir).map((f) => readFileSync(join(h.receiptDir, f), 'utf8')).join('');
    assert.ok(!raw.includes(TOKEN));
    assert.ok(!raw.includes('wrong-token-value'));
  } finally {
    await h.close();
  }
});

test('a 429 request writes a receipt too', async () => {
  let open!: () => void;
  const gate = new Promise<void>((r) => {
    open = r;
  });
  const h = await start('dQw4w9WgXcQ', { maxConcurrent: 1, gate });
  try {
    const first = fetch(`${h.base}/v1/captions/dQw4w9WgXcQ`, auth());
    await new Promise((r) => setTimeout(r, 100));
    await fetch(`${h.base}/v1/captions/dQw4w9WgXcQ`, auth());
    open();
    await first;
    const statuses = receipts(h.receiptDir).map((l) => l.status).sort();
    assert.deepEqual(statuses, [200, 429]);
  } finally {
    open();
    await h.close();
  }
});

test('startup without CAPTION_READER_TOKEN exits non-zero with one stderr line', () => {
  const env = { ...process.env };
  delete env.CAPTION_READER_TOKEN;
  const run = spawnSync(process.execPath, ['--import', 'tsx', 'src/caption-reader.ts'], {
    cwd: join(import.meta.dirname, '..'),
    env: { ...env, CAPTION_READER_RECEIPT_DIR: tmp(), PORT: '0' },
    encoding: 'utf8',
    timeout: 30_000,
  });
  assert.notEqual(run.status, 0);
  assert.equal(run.stderr.trim().split('\n').length, 1);
  assert.match(run.stderr, /CAPTION_READER_TOKEN/);
});
