import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captionsMain } from '../src/cli-captions.js';
import { main } from '../src/cli.js';
import type { CaptionRead, CaptionReader, CaptionUnavailableReason } from '../src/captions.js';
import type { GeminiCaller } from '../src/gemini.js';

// agentfleet-team/fisheraiagent#89: `transcribe captions` prints a Transcript
// from the caption track alone. No test here touches the network or a key.

const ID = 'dQw4w9WgXcQ';
const CUES = [
  { start: 0, end: 3, text: 'never gonna' },
  { start: 3, end: 6, text: 'give you up' },
  { start: 9, end: 12, text: 'never gonna let you down' },
];

const fixed = (read: CaptionRead): CaptionReader => async () => read;

async function run(args: string[], reader: CaptionReader) {
  let stdout = '';
  let stderr = '';
  const code = await captionsMain(args, {
    reader,
    stdout: (s) => { stdout += s; },
    stderr: (s) => { stderr += s; },
    now: () => new Date('2026-11-27T03:00:00.000Z'),
  });
  return { code, stdout, stderr };
}

test('manual track: exit 0 and a captions:manual Transcript', async () => {
  const r = await run([ID], fixed({ kind: 'manual', language: 'en', durationSeconds: 12, cues: CUES }));
  assert.equal(r.code, 0);
  const t = JSON.parse(r.stdout);
  assert.equal(t.video_id, ID);
  assert.equal(t.source_url, `https://www.youtube.com/watch?v=${ID}`);
  assert.equal(t.language, 'en');
  assert.equal(t.source, 'captions:manual');
  assert.ok(t.blocks.length > 0);
  assert.equal(r.stderr, '');
});

test('a full URL is accepted', async () => {
  const r = await run([`https://youtu.be/${ID}`], fixed({ kind: 'manual', language: 'en', durationSeconds: 12, cues: CUES }));
  assert.equal(r.code, 0);
  assert.equal(JSON.parse(r.stdout).video_id, ID);
});

test('auto track: exit 3 by default, exit 0 with captions:auto under manual-or-auto', async () => {
  const auto: CaptionRead = { kind: 'auto', language: 'en', durationSeconds: 12, cues: CUES };
  const denied = await run([ID], fixed(auto));
  assert.equal(denied.code, 3);
  assert.equal(denied.stdout, '');
  const explicit = await run([ID, '--accept', 'manual'], fixed(auto));
  assert.equal(explicit.code, 3);
  const taken = await run([ID, '--accept', 'manual-or-auto'], fixed(auto));
  assert.equal(taken.code, 0);
  assert.equal(JSON.parse(taken.stdout).source, 'captions:auto');
});

test('manual track under manual-or-auto stays captions:manual', async () => {
  const r = await run([ID, '--accept', 'manual-or-auto'], fixed({ kind: 'manual', language: 'en', durationSeconds: 12, cues: CUES }));
  assert.equal(r.code, 0);
  assert.equal(JSON.parse(r.stdout).source, 'captions:manual');
});

test('none: exit 3 under both policies, nothing on stdout', async () => {
  for (const accept of ['manual', 'manual-or-auto']) {
    const r = await run([ID, '--accept', accept], fixed({ kind: 'none' }));
    assert.equal(r.code, 3);
    assert.equal(r.stdout, '');
  }
});

test('each unavailable reason: exit 1 and one stderr line', async () => {
  const reasons: CaptionUnavailableReason[] = ['blocked', 'timeout', 'empty', 'parse', 'http', 'unreachable'];
  for (const reason of reasons) {
    const r = await run([ID], fixed({ kind: 'unavailable', reason }));
    assert.equal(r.code, 1);
    assert.equal(r.stdout, '');
    assert.equal(r.stderr, `captions_unavailable reason=${reason}\n`);
  }
});

test('usage errors: exit 2', async () => {
  assert.equal((await run([], fixed({ kind: 'none' }))).code, 2);
  assert.equal((await run([ID, '--accept', 'auto'], fixed({ kind: 'none' }))).code, 2);
  assert.equal((await run([ID, '--accept'], fixed({ kind: 'none' }))).code, 2);
  assert.equal((await run(['not a video'], fixed({ kind: 'none' }))).code, 2);
  assert.equal((await run([ID, '--bogus'], fixed({ kind: 'none' }))).code, 2);
});

test('receipt has every field, and a rerun overwrites it with the same blocks sha256', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fa-receipt-'));
  try {
    const file = join(dir, 'receipt.json');
    writeFileSync(file, 'stale');
    const read: CaptionRead = { kind: 'manual', language: 'en', durationSeconds: 12, cues: CUES };
    assert.equal((await run([ID, '--receipt', file], fixed(read))).code, 0);
    const first = JSON.parse(readFileSync(file, 'utf8'));
    assert.deepEqual(Object.keys(first).sort(), [
      'blocks_sha256', 'cue_count', 'fetched_at', 'kind', 'language', 'method', 'ms', 'reason', 'video_id',
    ]);
    assert.equal(first.video_id, ID);
    assert.equal(first.kind, 'manual');
    assert.equal(first.reason, null);
    assert.equal(first.language, 'en');
    assert.equal(first.cue_count, 3);
    assert.match(first.blocks_sha256, /^[0-9a-f]{64}$/);
    assert.equal(typeof first.ms, 'number');
    assert.equal(first.method, 'innertube-android');
    assert.equal(first.fetched_at, '2026-11-27T03:00:00.000Z');
    assert.equal((await run([ID, '--receipt', file], fixed(read))).code, 0);
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).blocks_sha256, first.blocks_sha256);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('receipt records none and unavailable outcomes with a null sha', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fa-receipt-'));
  try {
    const file = join(dir, 'receipt.json');
    await run([ID, '--receipt', file], fixed({ kind: 'none' }));
    assert.deepEqual(
      { ...JSON.parse(readFileSync(file, 'utf8')), ms: 0, fetched_at: '' },
      { video_id: ID, kind: 'none', reason: null, language: null, cue_count: 0, blocks_sha256: null, ms: 0, method: 'innertube-android', fetched_at: '' },
    );
    await run([ID, '--receipt', file], fixed({ kind: 'unavailable', reason: 'blocked' }));
    const u = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(u.kind, 'unavailable');
    assert.equal(u.reason, 'blocked');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('no Gemini call and no key read on any path', async () => {
  let geminiCalls = 0;
  const caller: GeminiCaller = async () => { geminiCalls += 1; return { text: '', status: 'completed' }; };
  const saved = process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  try {
    const reads: CaptionRead[] = [
      { kind: 'manual', language: 'en', durationSeconds: 12, cues: CUES },
      { kind: 'auto', language: 'en', durationSeconds: 12, cues: CUES },
      { kind: 'none' },
      { kind: 'unavailable', reason: 'blocked' },
    ];
    for (const read of reads) {
      const out = await main(['captions', ID], caller, fixed(read));
      assert.ok([0, 1, 3].includes(out));
    }
    assert.equal(geminiCalls, 0);
  } finally {
    if (saved !== undefined) process.env.GEMINI_API_KEY = saved;
  }
});
