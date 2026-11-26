import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createCaptionReader,
  chooseSource,
  cuesToBlocks,
  type CaptionRead,
  type Cue,
} from '../src/captions.js';
import { transcribeYouTube, type TranscribeDeps } from '../src/transcribe.js';
import type { GeminiCaller, GeminiVideoRequest } from '../src/gemini.js';
import { TranscriptError } from '../src/errors.js';

// Recorded YouTube responses captured by T0 (#66) and by this ticket's
// no-ASR Mandarin probe: <video>/player.json is the InnerTube `player`
// answer and <kind>.<lang>.json3 the timedtext answer for one track. The
// fake fetch below maps each request URL onto those files, so no test here
// touches the network.
const FIXTURES = new URL('../spike/captions/fixtures/innertube-android/', import.meta.url);

function fixtureFile(videoId: string, name: string): string {
  return readFileSync(new URL(`./${videoId}/${name}`, FIXTURES), 'utf8');
}

function fixtureFetch(videoId: string, playerJson?: string): typeof fetch {
  return async (input, _init) => {
    const url = String(input);
    if (url.includes('youtubei/v1/player')) {
      return new Response(playerJson ?? fixtureFile(videoId, 'player.json'), { status: 200 });
    }
    if (url.includes('timedtext')) {
      const lang = new URL(url).searchParams.get('lang') ?? '';
      const kind = new URL(url).searchParams.get('kind') === 'asr' ? 'asr' : 'manual';
      try {
        return new Response(fixtureFile(videoId, `${kind}.${lang}.json3`), { status: 200 });
      } catch {
        return new Response('no such track', { status: 404 });
      }
    }
    return new Response('not found', { status: 404 });
  };
}

const reader = (videoId: string, playerJson?: string) =>
  createCaptionReader({ fetchImpl: fixtureFetch(videoId, playerJson) });

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

const EMPTY = 'LANGUAGE: en';
const ONE_BLOCK = 'LANGUAGE: en\n[00:00 - 00:08] spoken words.';

function deps(caller: GeminiCaller, captionReader: TranscribeDeps['captionReader']): TranscribeDeps {
  return {
    caller,
    model: 'test-model',
    maxBlockSeconds: 8,
    cacheDir: mkdtempSync(join(tmpdir(), 'fa-cache-')),
    captionReader,
  };
}

// --- N3 choose-source: the default `manual` policy over every read kind ---

test('chooseSource: manual read blocks as captions:manual; every other kind falls back to gemini with the reason', () => {
  const table: Array<[CaptionRead, string, string | undefined]> = [
    [{ kind: 'manual', language: 'en', durationSeconds: 10, cues: [] }, 'captions:manual', undefined],
    [{ kind: 'auto', language: 'en', durationSeconds: 10, cues: [] }, 'gemini', 'auto'],
    [{ kind: 'none' }, 'gemini', 'none'],
    [{ kind: 'unavailable', reason: 'blocked' }, 'gemini', 'blocked'],
    [{ kind: 'unavailable', reason: 'timeout' }, 'gemini', 'timeout'],
    [{ kind: 'unavailable', reason: 'empty' }, 'gemini', 'empty'],
    [{ kind: 'unavailable', reason: 'parse' }, 'gemini', 'parse'],
    [{ kind: 'unavailable', reason: 'http' }, 'gemini', 'http'],
  ];
  for (const [read, source, reason] of table) {
    assert.deepEqual(chooseSource(read), reason === undefined ? { source } : { source, reason });
  }
});

// --- N4a cues-to-blocks: pure split/merge to the block cap ---

test('cuesToBlocks merges short cues up to the block cap and keeps time order', () => {
  const cues: Cue[] = [
    { start: 0, end: 4, text: 'one' },
    { start: 4, end: 8, text: 'two' },
    { start: 8, end: 9, text: 'three' },
    { start: 10, end: 20, text: 'four' },
  ];
  assert.deepEqual(cuesToBlocks(cues, 8), [
    { start: 0, end: 8, text: 'one two' },
    { start: 8, end: 9, text: 'three' },
    { start: 10, end: 20, text: 'four' },
  ]);
});

test('cuesToBlocks keeps a cue longer than the cap whole — its own timing is the only honest one', () => {
  const blocks = cuesToBlocks(
    [
      { start: 0, end: 2, text: 'short' },
      { start: 2, end: 15, text: 'one long cue' },
    ],
    8,
  );
  assert.deepEqual(blocks, [
    { start: 0, end: 2, text: 'short' },
    { start: 2, end: 15, text: 'one long cue' },
  ]);
});

test('cuesToBlocks never produces overlapping or out-of-order blocks', () => {
  const cues: Cue[] = [
    { start: 0, end: 7, text: 'a' },
    { start: 6, end: 9, text: 'b' }, // overlaps a
    { start: 8.5, end: 12, text: 'c' },
    { start: 12, end: 13, text: 'd' },
  ];
  const blocks = cuesToBlocks(cues, 8);
  for (let i = 1; i < blocks.length; i++) {
    assert.ok(blocks[i].start >= blocks[i - 1].end, 'blocks must not overlap');
    assert.ok(blocks[i].end >= blocks[i - 1].end, 'block end must not go backwards');
  }
});

// --- N2 the reader on recorded fixtures ---

test('a manual track in the spoken language reads as manual with its cues', async () => {
  for (const [videoId, language, cueCount] of [
    ['dQw4w9WgXcQ', 'en', 61],
    ['UF8uR6Z6KLc', 'en', 244],
    ['arj7oStGLkU', 'en', 315],
  ] as const) {
    const read = await reader(videoId)(videoId);
    assert.equal(read.kind, 'manual', videoId);
    if (read.kind === 'manual') {
      assert.equal(read.language, language);
      assert.equal(read.cues.length, cueCount);
      assert.ok(read.durationSeconds > 0);
    }
  }
});

test('asr only: the original asr track is picked by the default audio track, translations are ignored', async () => {
  for (const [videoId, cueCount] of [
    ['hWe-j78vNpc', 255],
    ['3JZ_D3ELwOQ', 108],
  ] as const) {
    const read = await reader(videoId)(videoId);
    assert.equal(read.kind, 'auto', videoId);
    if (read.kind === 'auto') {
      // The en original: the ar and nl-NL control tracks hold 222 and 117 cues.
      assert.equal(read.language, 'en');
      assert.equal(read.cues.length, cueCount);
    }
  }
});

test('a manual track only in another language than the spoken one is ignored', async () => {
  // The same recorded video minus its en manual track: only non-spoken
  // manuals remain, so the read is auto, not manual.
  const player = JSON.parse(fixtureFile('dQw4w9WgXcQ', 'player.json')) as {
    captions: { playerCaptionsTracklistRenderer: { captionTracks: { vssId?: string }[] } };
  };
  const renderer = player.captions.playerCaptionsTracklistRenderer;
  renderer.captionTracks = renderer.captionTracks.filter((t) => t.vssId !== '.en');
  const read = await reader('dQw4w9WgXcQ', JSON.stringify(player))('dQw4w9WgXcQ');
  assert.equal(read.kind, 'auto');
});

test('no tracks at all reads as none and still carries the player duration', async () => {
  const read = await reader('aqz-KE-bpKQ')('aqz-KE-bpKQ');
  assert.equal(read.kind, 'none');
  assert.equal(read.durationSeconds, 635);
});

test('no asr track: a single manual track is the original; two or more is ambiguous and stays none', async () => {
  const single = await reader('j_t0XlFoCjU')('j_t0XlFoCjU');
  assert.equal(single.kind, 'manual');
  if (single.kind === 'manual') {
    assert.equal(single.language, 'zh-TW');
    assert.equal(single.cues.length, 246);
  }
  for (const videoId of ['snZ811wvjjw', '6i7RcP39NB0', 'tx6of5YHqCA', 'kJQP7kiw5Fk'] as const) {
    const read = await reader(videoId)(videoId);
    assert.equal(read.kind, 'none', `${videoId} must stay none: no signal names the original among several manual tracks`);
  }
});

test('every YouTube-side failure is unavailable with its reason, never a throw', async () => {
  const cases: Array<[string, typeof fetch, string]> = [
    ['http', () => Promise.resolve(new Response('upstream', { status: 500 })), 'http'],
    ['parse', () => Promise.resolve(new Response('<html>not json</html>', { status: 200 })), 'parse'],
    ['empty', () => Promise.resolve(new Response('', { status: 200 })), 'empty'],
    [
      'timeout',
      () => Promise.reject(Object.assign(new Error('The operation timed out'), { name: 'TimeoutError' })),
      'timeout',
    ],
    ['http', () => Promise.reject(new TypeError('fetch failed')), 'http'],
  ];
  for (const [name, fetchImpl, reason] of cases) {
    const read = await createCaptionReader({ fetchImpl })('dQw4w9WgXcQ');
    assert.equal(read.kind, 'unavailable', name);
    if (read.kind === 'unavailable') assert.equal(read.reason, reason);
  }
  const blocked = await reader(
    'dQw4w9WgXcQ',
    JSON.stringify({ playabilityStatus: { status: 'LOGIN_REQUIRED', reason: 'Sign in to confirm you’re not a bot' } }),
  )('dQw4w9WgXcQ');
  assert.equal(blocked.kind, 'unavailable');
  if (blocked.kind === 'unavailable') assert.equal(blocked.reason, 'blocked');
});

// --- Entry point: N2 -> N3 -> N4a/N4b chained through transcribeYouTube ---

test('a manual read returns the transcript from cues with source captions:manual and zero Gemini calls', async () => {
  const { calls, caller } = geminiDouble([{ text: ONE_BLOCK }, { text: EMPTY }]);
  let reads = 0;
  const logs: string[] = [];
  const read: CaptionRead = {
    kind: 'manual',
    language: 'zh-TW',
    durationSeconds: 24,
    cues: [
      { start: 0, end: 4, text: '第一句' },
      { start: 4, end: 8, text: '第二句' },
      { start: 8, end: 16, text: '第三句' },
    ],
  };
  const d = deps(
    caller,
    async () => {
      reads += 1;
      return read;
    },
  );
  d.log = (line) => logs.push(line);
  const t = await transcribeYouTube('snZ811wvjjw', d);
  assert.equal(calls.length, 0, 'a manual track must not spend a Gemini call');
  assert.equal(t.source, 'captions:manual');
  assert.equal(t.language, 'zh-TW');
  assert.deepEqual(t.blocks, [
    { start: 0, end: 8, text: '第一句 第二句' },
    { start: 8, end: 16, text: '第三句' },
  ]);
  assert.ok(logs.some((l) => l.startsWith('captions_read') && l.includes('kind=manual')));
  assert.ok(logs.some((l) => l.startsWith('source_chosen') && l.includes('source=captions:manual')));
});

test('a captions transcript is not cached: a second run reads captions again and still calls no Gemini', async () => {
  const { calls, caller } = geminiDouble([]);
  let reads = 0;
  const d = deps(caller, async () => {
    reads += 1;
    return {
      kind: 'manual',
      language: 'en',
      durationSeconds: 4,
      cues: [{ start: 0, end: 4, text: 'hi' }],
    };
  });
  const first = await transcribeYouTube('dQw4w9WgXcQ', d);
  const second = await transcribeYouTube('dQw4w9WgXcQ', d);
  assert.deepEqual(second, first);
  assert.equal(reads, 2, 'caption results are not served from the transcript cache');
  assert.equal(calls.length, 0);
  assert.equal(readdirSync(d.cacheDir).length, 0, 'a caption result must not write a cache file');
});

test('auto, none and every unavailable reason go to Gemini with source gemini', async () => {
  const reads: CaptionRead[] = [
    { kind: 'auto', language: 'en', durationSeconds: 60, cues: [] },
    { kind: 'none', durationSeconds: 60 },
    { kind: 'unavailable', reason: 'blocked' },
    { kind: 'unavailable', reason: 'timeout' },
    { kind: 'unavailable', reason: 'empty' },
    { kind: 'unavailable', reason: 'parse' },
    { kind: 'unavailable', reason: 'http' },
  ];
  for (const read of reads) {
    const { calls, caller } = geminiDouble([{ text: ONE_BLOCK }, { text: EMPTY }]);
    const logs: string[] = [];
    const d = deps(caller, async () => read);
    d.log = (line) => logs.push(line);
    const t = await transcribeYouTube('hWe-j78vNpc', d);
    assert.equal(t.source, 'gemini', JSON.stringify(read));
    assert.equal(calls.length, 2, 'the Gemini path runs exactly as today');
    const reason = read.kind === 'unavailable' ? read.reason : read.kind;
    assert.ok(
      logs.some((l) => l.startsWith('source_chosen') && l.includes('source=gemini') && l.includes(`reason=${reason}`)),
      `source_chosen must carry the fallback reason for ${JSON.stringify(read)}`,
    );
  }
});

test('a reader that throws is treated as unavailable and the job still goes to Gemini', async () => {
  const { calls, caller } = geminiDouble([{ text: ONE_BLOCK }, { text: EMPTY }]);
  const d = deps(caller, async () => {
    throw new Error('reader bug');
  });
  const t = await transcribeYouTube('hWe-j78vNpc', d);
  assert.equal(t.source, 'gemini');
  assert.equal(calls.length, 2);
});

test('the reader duration enforces max_video_seconds before any work', async () => {
  const { calls, caller } = geminiDouble([]);
  const d = deps(caller, async () => ({
    kind: 'manual',
    language: 'en',
    durationSeconds: 500,
    cues: [{ start: 0, end: 4, text: 'hi' }],
  }));
  d.maxVideoSeconds = 100;
  await assert.rejects(
    () => transcribeYouTube('dQw4w9WgXcQ', d),
    (err: unknown) => err instanceof TranscriptError && err.code === 'video_too_long',
  );
  assert.equal(calls.length, 0);
});
