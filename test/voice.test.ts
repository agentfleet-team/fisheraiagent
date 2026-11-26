import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';
import { chunkText, MAX_CHUNK_CHARS } from '../src/voice/chunk.js';
import { parseVoiceRequest } from '../src/voice/contract.js';
import type { EngineRequest, EngineResult, VoiceEngine } from '../src/voice/engine.js';
import { createVoiceService } from '../src/voice/service.js';
import type { VoiceDrive } from '../src/voice/save.js';

const requestBody = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', 'voice', 'request.json'), 'utf8'));

const MS_PER_CHAR = 200;
const BYTES_PER_MS = 6; // 48 kbit/s

// A stub TTS engine: 200 ms of audio per character, one sentence boundary per
// sentence. `failures` lists texts (by prefix) that fail a given number of times.
function stubEngine(failures: Record<string, number> = {}): { engine: VoiceEngine; calls: string[] } {
  const calls: string[] = [];
  const remaining = new Map(Object.entries(failures));
  const engine: VoiceEngine = async ({ text }: EngineRequest): Promise<EngineResult> => {
    calls.push(text);
    for (const [prefix, left] of remaining) {
      if (text.startsWith(prefix) && left > 0) {
        remaining.set(prefix, left - 1);
        throw new Error('stub tts failure');
      }
    }
    const sentences: EngineResult['sentences'] = [];
    let offset = 0;
    for (const s of text.match(/[^。！？]+[。！？]?/gu) ?? []) {
      const duration = [...s].length * MS_PER_CHAR;
      sentences.push({ text: s, offset_ms: offset, duration_ms: duration });
      offset += duration;
    }
    return { audio: Buffer.alloc(offset * BYTES_PER_MS, 1), sentences };
  };
  return { engine, calls };
}

class StubDrive implements VoiceDrive {
  readonly files: { id: string; folder: string; name: string; content: Buffer | string }[] = [];
  async findFileByName(folderId: string, name: string) {
    return this.files.find((f) => f.folder === folderId && f.name === name) ?? null;
  }
  async createFile(folderId: string, name: string, content: Buffer | string) {
    const file = { id: `stub-file-${this.files.length + 1}`, folder: folderId, name, content };
    this.files.push(file);
    return { id: file.id, name };
  }
}

async function withService<T>(
  options: Parameters<typeof createVoiceService>[0],
  fn: (base: string) => Promise<T>,
): Promise<T> {
  const server: Server = createVoiceService(options);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  try {
    return await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
}

async function post(base: string, body: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${base}/v1/jobs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

async function settle(base: string, jobId: string): Promise<Record<string, any>> {
  for (let i = 0; i < 300; i++) {
    const view = (await (await fetch(`${base}/v1/jobs/${jobId}`)).json()) as Record<string, any>;
    if (view.status === 'done' || view.status === 'failed') return view;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('job did not settle');
}

const tenants = JSON.stringify({
  tenants: [{ id: 't', caller: { token_env: 'VOICE_TEST_CALLER_TOKEN' }, destination: { type: 'google-drive', folder_id: 'folder-1' } }],
});
process.env.VOICE_TEST_CALLER_TOKEN = 'tok';

const withExpect = (min: number, max: number): unknown => ({ ...requestBody, expect_seconds: { min, max } });

test('V1: a valid request with a stub engine returns done with a VoiceResult; marks are ordered, non-overlapping and cover every section', async () => {
  const { engine } = stubEngine();
  await withService({ engine }, async (base) => {
    const sent = await post(base, requestBody);
    assert.equal(sent.status, 202);
    const view = await settle(base, sent.body.job_id);
    assert.equal(view.status, 'done');
    const result = view.result;
    assert.equal(result.format, 'audio-24khz-48kbitrate-mono-mp3');
    assert.match(result.sha256, /^[0-9a-f]{64}$/);
    const totalChars = requestBody.sections.reduce((n: number, s: { text: string }) => n + [...s.text].length, 0);
    assert.equal(result.duration_s, (totalChars * MS_PER_CHAR) / 1000);
    assert.equal(result.bytes, totalChars * MS_PER_CHAR * BYTES_PER_MS);
    assert.equal(result.saved, undefined);

    const marks = result.marks as { section_id: string; index: number; start_ms: number; end_ms: number; text: string }[];
    let previousEnd = 0;
    for (const m of marks) {
      assert.ok(m.start_ms >= previousEnd, 'marks do not overlap');
      assert.ok(m.end_ms >= m.start_ms);
      previousEnd = m.end_ms;
    }
    assert.ok(previousEnd <= result.duration_s * 1000);
    assert.deepEqual(
      [...new Set(marks.map((m) => m.section_id))],
      requestBody.sections.map((s: { id: string }) => s.id),
    );
    // one mark per sentence, and the marks carry all the spoken text
    assert.equal(marks.map((m) => m.text).join(''), requestBody.sections.map((s: { text: string }) => s.text).join(''));
    assert.deepEqual(marks.filter((m) => m.section_id === 's1').map((m) => m.index), [0, 1, 2]);

    const audio = await fetch(`${base}/v1/jobs/${sent.body.job_id}/audio`);
    assert.equal(audio.headers.get('content-type'), 'audio/mpeg');
    assert.equal((await audio.arrayBuffer()).byteLength, result.bytes);
  });
});

test('V1: a long section is cut into chunks and later marks are offset by earlier chunks', async () => {
  const sentence = '這是一個用來測試的句子，長度剛好夠用。';
  const long = { ...requestBody, sections: [{ id: 'long', text: sentence.repeat(200) }], expect_seconds: { min: 1, max: 100000 } };
  const { engine, calls } = stubEngine();
  await withService({ engine }, async (base) => {
    const view = await settle(base, (await post(base, long)).body.job_id);
    assert.equal(view.status, 'done');
    assert.ok(calls.length > 1);
    assert.ok(calls.every((c) => [...c].length <= MAX_CHUNK_CHARS));
    const marks = view.result.marks as { start_ms: number; end_ms: number }[];
    assert.equal(marks.length, 200);
    for (let i = 1; i < marks.length; i++) assert.ok(marks[i].start_ms >= marks[i - 1].end_ms);
    assert.equal(marks[199].end_ms, view.result.duration_s * 1000);
  });
});

test('V2: a chunk failing once is retried alone and the job is done', async () => {
  const { engine, calls } = stubEngine({ 第一個主題: 1 });
  await withService({ engine }, async (base) => {
    const view = await settle(base, (await post(base, requestBody)).body.job_id);
    assert.equal(view.status, 'done');
    assert.equal(calls.filter((c) => c.startsWith('第一個主題')).length, 2);
    assert.equal(calls.filter((c) => c.startsWith('早安')).length, 1);
    assert.equal(calls.filter((c) => c.startsWith('以上就是')).length, 1);
  });
});

test('V2: a section failing twice ends the job failed with the section id and stops there', async () => {
  const { engine, calls } = stubEngine({ 第一個主題: 2 });
  await withService({ engine }, async (base) => {
    const view = await settle(base, (await post(base, requestBody)).body.job_id);
    assert.equal(view.status, 'failed');
    assert.equal(view.error.code, 'render_failed');
    assert.equal(view.error.section_id, 's1');
    assert.equal(view.result, undefined);
    assert.equal(calls.filter((c) => c.startsWith('以上就是')).length, 0);
  });
});

test('V2: a chunk that runs past its time limit counts as a failure', async () => {
  const hang: VoiceEngine = () => new Promise(() => {});
  await withService({ engine: hang, chunkTimeoutMs: 20 }, async (base) => {
    const view = await settle(base, (await post(base, requestBody)).body.job_id);
    assert.equal(view.status, 'failed');
    assert.equal(view.error.code, 'render_failed');
    assert.equal(view.error.section_id, 'opening');
  });
});

test('V2: an engine result with no audio or no sentence boundary is a failure, never a partial file', async () => {
  const empty: VoiceEngine = async () => ({ audio: Buffer.alloc(0), sentences: [] });
  const silent: VoiceEngine = async () => ({ audio: Buffer.alloc(600, 1), sentences: [] });
  for (const engine of [empty, silent]) {
    await withService({ engine }, async (base) => {
      const view = await settle(base, (await post(base, requestBody)).body.job_id);
      assert.equal(view.status, 'failed');
      assert.equal(view.error.code, 'render_failed');
    });
  }
});

test('V3: a duration outside expect_seconds ends failed duration_out_of_band and saves nothing', async () => {
  for (const band of [withExpect(100, 200), withExpect(1, 5)]) {
    const drive = new StubDrive();
    await withService({ engine: stubEngine().engine, drive, tenantsJson: tenants }, async (base) => {
      const sent = await post(base, band, { authorization: 'Bearer tok' });
      const view = await settle(base, sent.body.job_id);
      assert.equal(view.status, 'failed');
      assert.equal(view.error.code, 'duration_out_of_band');
      assert.equal(view.result, undefined);
      assert.equal(drive.files.length, 0);
      assert.equal((await fetch(`${base}/v1/jobs/${sent.body.job_id}/audio`)).status, 404);
    });
  }
});

test('V4: the same Idempotency-Key twice renders once; another request on that key is a conflict', async () => {
  const { engine, calls } = stubEngine();
  await withService({ engine }, async (base) => {
    const first = await post(base, requestBody, { 'idempotency-key': 'k-1' });
    await settle(base, first.body.job_id);
    const renders = calls.length;
    const second = await post(base, requestBody, { 'idempotency-key': 'k-1' });
    assert.equal(second.status, 202);
    assert.equal(second.body.job_id, first.body.job_id);
    assert.equal(calls.length, renders);
    const other = await post(base, withExpect(10, 50), { 'idempotency-key': 'k-1' });
    assert.equal(other.status, 409);
    assert.equal(other.body.error.code, 'idempotency_conflict');
    assert.equal(calls.length, renders);
  });
});

test('validate: a bad request is a 400 and reaches no engine', async () => {
  const { engine, calls } = stubEngine();
  const bad: unknown[] = [
    {},
    { ...requestBody, sections: [] },
    { ...requestBody, sections: [{ id: 'a', text: 'x' }, { id: 'a', text: 'y' }] },
    { ...requestBody, sections: [{ id: 'a', text: '   ' }] },
    { ...requestBody, voice: { ...requestBody.voice, engine: 'other' } },
    { ...requestBody, voice: { ...requestBody.voice, rate: 'fast' } },
    { ...requestBody, expect_seconds: { min: 50, max: 10 } },
    { ...requestBody, date: '2026-02-30' },
  ];
  await withService({ engine }, async (base) => {
    for (const body of bad) {
      const res = await post(base, body);
      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, 'invalid_request');
    }
    assert.equal(calls.length, 0);
  });
  assert.ok(parseVoiceRequest(requestBody));
});

test('save: a tenant with a google-drive destination gets both files once; existing names are not rewritten', async () => {
  const drive = new StubDrive();
  await withService({ engine: stubEngine().engine, drive, tenantsJson: tenants }, async (base) => {
    for (let i = 0; i < 2; i++) {
      const view = await settle(base, (await post(base, requestBody, { authorization: 'Bearer tok' })).body.job_id);
      assert.equal(view.status, 'done');
      assert.deepEqual(view.result.saved.names, ['2026-11-28-episode.mp3', '2026-11-28-marks.json']);
    }
    assert.deepEqual(drive.files.map((f) => f.name), ['2026-11-28-episode.mp3', '2026-11-28-marks.json']);
    assert.ok(Buffer.isBuffer(drive.files[0].content));
  });
});

test('save: a Drive failure leaves the job done with save_error', async () => {
  const drive: VoiceDrive = {
    findFileByName: async () => {
      throw new Error('drive down');
    },
    createFile: async () => {
      throw new Error('drive down');
    },
  };
  await withService({ engine: stubEngine().engine, drive, tenantsJson: tenants }, async (base) => {
    const view = await settle(base, (await post(base, requestBody, { authorization: 'Bearer tok' })).body.job_id);
    assert.equal(view.status, 'done');
    assert.equal(view.save_error.code, 'save_failed');
    assert.equal(view.result.saved, undefined);
  });
});

test('auth: with SERVICE_TOKEN set, /v1 needs the bearer token', async () => {
  await withService({ engine: stubEngine().engine, serviceToken: 's3cret' }, async (base) => {
    assert.equal((await post(base, requestBody)).status, 401);
    assert.equal((await post(base, requestBody, { authorization: 'Bearer s3cret' })).status, 202);
    assert.equal((await fetch(`${base}/healthz`)).status, 200);
  });
});

test('chunkText cuts at sentence ends within the limit and loses no text', () => {
  const text = '甲乙丙丁。'.repeat(100);
  const chunks = chunkText(text, 50);
  assert.ok(chunks.every((c) => [...c].length <= 50));
  assert.ok(chunks.every((c) => c.endsWith('。')));
  assert.equal(chunks.join(''), text);
  const noStop = chunkText('一二三，'.repeat(40), 30);
  assert.ok(noStop.every((c) => [...c].length <= 30));
  assert.equal(noStop.join(''), '一二三，'.repeat(40));
});
