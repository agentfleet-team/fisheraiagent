import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { transcribeVideo, type TranscribeDeps } from '../src/transcribe.js';
import type { GeminiCaller, GeminiVideoRequest, GeminiVideoResponse } from '../src/gemini.js';
import { TranscriptError } from '../src/errors.js';

// Recorded model text for a clip answers in clip-relative time: the first
// frame of every clip is 00:00 and the caller shifts it back by the clip's
// known start. Window size in these deps is 40 s, so one window is five
// 8-second blocks.
const EMPTY = 'LANGUAGE: en';

function geminiDouble(
  responses: Array<{ text?: string; status?: string; error?: unknown; usage?: GeminiVideoResponse['usage'] }>,
): { calls: GeminiVideoRequest[]; caller: GeminiCaller } {
  const calls: GeminiVideoRequest[] = [];
  const queue = [...responses];
  const caller: GeminiCaller = async (req) => {
    calls.push(req);
    const next = queue.shift();
    if (!next) throw new Error('gemini double exhausted');
    if (next.error) throw next.error;
    const res: GeminiVideoResponse = { text: next.text ?? '', status: next.status ?? 'completed' };
    if (next.usage) res.usage = next.usage;
    return res;
  };
  return { calls, caller };
}

function deps(caller: GeminiCaller, windowSeconds = 40): TranscribeDeps {
  return {
    caller,
    model: 'test-model',
    maxBlockSeconds: 8,
    cacheDir: mkdtempSync(join(tmpdir(), 'fa-cache-')),
    windowSeconds,
  };
}

function assertContiguous(blocks: Array<{ start: number; end: number }>) {
  for (let i = 1; i < blocks.length; i++) {
    assert.ok(blocks[i].start >= blocks[i - 1].end, `block ${i} overlaps or duplicates the previous block`);
    assert.ok(blocks[i].end >= blocks[i - 1].end, 'block end must not go backwards');
  }
}

test('windows are contiguous: later windows offset clip-relative times and a speechless window ends the video', async () => {
  const w0 = [
    'LANGUAGE: en',
    '[00:00 - 00:08] one.',
    '[00:08 - 00:16] two.',
    '[00:16 - 00:24] three.',
    '[00:24 - 00:32] four.',
    '[00:32 - 00:40] five',
  ].join('\n');
  const w1 = ['LANGUAGE: en', '[00:00 - 00:08] six.', '[00:08 - 00:16] seven.'].join('\n');
  const { calls, caller } = geminiDouble([{ text: w0 }, { text: w1 }, { text: EMPTY }]);

  const t = await transcribeVideo('hWe-j78vNpc', deps(caller));

  assert.equal(calls.length, 3);
  assert.equal(calls[0].startOffsetSeconds, 0);
  assert.equal(calls[0].endOffsetSeconds, 40);
  assert.equal(calls[1].startOffsetSeconds, 40);
  assert.equal(calls[1].endOffsetSeconds, 80);
  assert.equal(calls[2].startOffsetSeconds, 80);
  assert.equal(calls[2].endOffsetSeconds, 120);
  assert.equal(t.language, 'en');
  assert.equal(t.blocks.length, 7);
  assert.deepEqual(t.blocks[5], { start: 40, end: 48, text: 'six.' });
  assert.equal(t.blocks.at(-1)?.end, 56);
  assertContiguous(t.blocks);
});

test('a window is complete when its coverage reaches the known window end, even mid-sentence', async () => {
  const w0 = 'LANGUAGE: en\n[00:32 - 00:40] tail words';
  const { calls, caller } = geminiDouble([{ text: w0 }, { text: EMPTY }]);
  const t = await transcribeVideo('hWe-j78vNpc', deps(caller));
  // No tail rerun: coverage reaching 40 finished the window; call two is
  // the next window, which reports no speech.
  assert.equal(calls.length, 2);
  assert.equal(calls[1].startOffsetSeconds, 40);
  assert.equal(t.blocks.at(-1)?.end, 40);
});

test('block times are clamped to the window end and a block starting past it is dropped', async () => {
  const w0 = [
    'LANGUAGE: en',
    '[00:00 - 00:08] one.',
    '[00:34 - 00:42] past the clip end.',
    '[00:45 - 00:53] beyond the clip',
  ].join('\n');
  const { calls, caller } = geminiDouble([
    { text: w0 },
    { text: EMPTY }, // the 16-40 hole rerun confirms silence
    { text: EMPTY }, // window [40, 80) ends the video
  ]);
  const t = await transcribeVideo('hWe-j78vNpc', deps(caller));
  assert.equal(calls.length, 3);
  assert.equal(calls[1].startOffsetSeconds, 8);
  assert.equal(calls[1].endOffsetSeconds, 40);
  assert.equal(t.blocks.length, 2);
  assert.deepEqual(t.blocks[1], { start: 34, end: 40, text: 'past the clip end.' });
  assertContiguous(t.blocks);
});

test('a hole inside a window is re-covered by a clipped rerun that cannot duplicate coverage', async () => {
  const w0 = [
    'LANGUAGE: en',
    '[00:00 - 00:08] a.',
    '[00:08 - 00:16] b.',
    '[00:30 - 00:38] c.',
  ].join('\n');
  // The rerun covers [16, 40): its last block re-states the tail the first
  // call already covered and must be dropped, not duplicated.
  const fill = [
    'LANGUAGE: en',
    '[00:00 - 00:08] d.',
    '[00:08 - 00:14] e.',
    '[00:14 - 00:22] c again.',
  ].join('\n');
  const { calls, caller } = geminiDouble([{ text: w0 }, { text: fill }, { text: EMPTY }]);
  const t = await transcribeVideo('hWe-j78vNpc', deps(caller));
  assert.equal(calls.length, 3);
  assert.equal(calls[1].startOffsetSeconds, 16);
  assert.equal(calls[1].endOffsetSeconds, 40);
  assert.deepEqual(
    t.blocks.map((b) => b.start),
    [0, 8, 16, 24, 30],
  );
  assert.equal(t.blocks.at(-1)?.text, 'c.');
  assertContiguous(t.blocks);
});

test('a hole rerun that reports no more audio leaves the window coverage as-is', async () => {
  const w0 = [
    'LANGUAGE: en',
    '[00:00 - 00:08] a.',
    '[00:08 - 00:16] b.',
    '[00:30 - 00:38] c.',
  ].join('\n');
  const { calls, caller } = geminiDouble([{ text: w0 }, { text: EMPTY }, { text: EMPTY }]);
  const t = await transcribeVideo('hWe-j78vNpc', deps(caller));
  assert.equal(calls.length, 3);
  assert.equal(calls[1].startOffsetSeconds, 16);
  assert.deepEqual(
    t.blocks.map((b) => b.start),
    [0, 8, 30],
  );
});

test('coverage ending mid-sentence inside a window is rerun from where it broke off', async () => {
  const w0 = 'LANGUAGE: en\n[00:00 - 00:08] a\n[00:08 - 00:16] mid sentence';
  const tail = 'LANGUAGE: en\n[00:00 - 00:08] rest of it.\n[00:08 - 00:16] done.';
  const { calls, caller } = geminiDouble([{ text: w0 }, { text: tail }, { text: EMPTY }]);
  const t = await transcribeVideo('hWe-j78vNpc', deps(caller));
  assert.equal(calls.length, 3);
  assert.equal(calls[1].startOffsetSeconds, 16);
  assert.equal(calls[1].endOffsetSeconds, 40);
  assert.deepEqual(
    t.blocks.map((b) => b.start),
    [0, 8, 16, 24],
  );
});

test('an incomplete interaction status also triggers a tail rerun inside the window', async () => {
  const w0 = 'LANGUAGE: en\n[00:00 - 00:08] first block';
  const tail = [
    'LANGUAGE: en',
    '[00:00 - 00:08] b',
    '[00:08 - 00:16] c',
    '[00:16 - 00:24] d',
    '[00:24 - 00:32] e',
  ].join('\n');
  const { calls, caller } = geminiDouble([
    { text: w0, status: 'incomplete' },
    { text: tail },
    { text: EMPTY },
  ]);
  const t = await transcribeVideo('hWe-j78vNpc', deps(caller));
  assert.equal(calls.length, 3);
  assert.equal(calls[1].startOffsetSeconds, 8);
  assert.equal(calls[1].endOffsetSeconds, 40);
  assert.equal(t.blocks.length, 5);
  assert.equal(t.blocks.at(-1)?.end, 40);
});

test('a window that returns no speech ends the video', async () => {
  const { calls, caller } = geminiDouble([
    { text: 'LANGUAGE: en\n[00:00 - 00:08] only block.' },
    { text: EMPTY },
  ]);
  const t = await transcribeVideo('hWe-j78vNpc', deps(caller));
  assert.equal(calls.length, 2);
  assert.equal(t.blocks.length, 1);
});

test('a wholly speechless first window fails with bad_model_output', async () => {
  const { calls, caller } = geminiDouble([{ text: EMPTY }]);
  await assert.rejects(
    () => transcribeVideo('hWe-j78vNpc', deps(caller)),
    (err: unknown) => err instanceof TranscriptError && err.code === 'bad_model_output',
  );
  assert.equal(calls.length, 1);
});

test('a start offset past the video end ends the video instead of failing', async () => {
  const err = new TranscriptError('video_unavailable', 'INVALID_ARGUMENT: start_offset past end', {
    httpStatus: 400,
  });
  const { calls, caller } = geminiDouble([
    { text: 'LANGUAGE: en\n[00:00 - 00:08] only block.' },
    { error: err },
  ]);
  const t = await transcribeVideo('hWe-j78vNpc', deps(caller));
  assert.equal(calls.length, 2);
  assert.equal(calls[1].startOffsetSeconds, 40);
  assert.equal(t.blocks.at(-1)?.end, 8);
});

test('a key_rejected 400 on a later window propagates instead of ending the video', async () => {
  const { calls, caller } = geminiDouble([
    { text: 'LANGUAGE: en\n[00:00 - 00:08] first words.' },
    { error: new TranscriptError('key_rejected', 'API key not valid', { httpStatus: 400 }) },
  ]);
  await assert.rejects(
    () => transcribeVideo('hWe-j78vNpc', deps(caller)),
    (err: unknown) => err instanceof TranscriptError && err.code === 'key_rejected',
  );
  assert.equal(calls.length, 2);
});

test('permanent errors are not retried', async () => {
  const { calls, caller } = geminiDouble([
    { error: new TranscriptError('quota_exceeded', 'RESOURCE_EXHAUSTED', { httpStatus: 429 }) },
  ]);
  await assert.rejects(
    () => transcribeVideo('hWe-j78vNpc', deps(caller)),
    (err: unknown) => err instanceof TranscriptError && err.code === 'quota_exceeded',
  );
  assert.equal(calls.length, 1);
});

test('bad model output is retried once against the same clip, then fails', async () => {
  const garbage = "I'm sorry, but I can't provide a transcript for this clip.";
  const { calls, caller } = geminiDouble([{ text: garbage }, { text: garbage }]);
  await assert.rejects(
    () => transcribeVideo('hWe-j78vNpc', deps(caller)),
    (err: unknown) => err instanceof TranscriptError && err.code === 'bad_model_output',
  );
  assert.equal(calls.length, 2);
  assert.equal(calls[1].startOffsetSeconds, 0);
  assert.equal(calls[1].endOffsetSeconds, 40);
});

test('the strict retry recovers a one-off bad response', async () => {
  const { calls, caller } = geminiDouble([
    { text: 'no transcript here' },
    { text: 'LANGUAGE: en\n[00:00 - 00:08] recovered.' },
    { text: EMPTY },
  ]);
  const t = await transcribeVideo('hWe-j78vNpc', deps(caller));
  assert.equal(calls.length, 3);
  assert.equal(t.blocks.length, 1);
});

test('a zero-length block at whole-second precision merges into the transcript', async () => {
  const w0 = [
    'LANGUAGE: zh-TW',
    '[00:00 - 00:08] 大家好',
    '[00:08 - 00:08] 好。',
    '[00:08 - 00:16] 繼續說下去。',
  ].join('\n');
  const { caller } = geminiDouble([{ text: w0 }, { text: 'LANGUAGE: zh-TW' }]);
  const t = await transcribeVideo('hWe-j78vNpc', deps(caller));
  assert.deepEqual(t.blocks[1], { start: 8, end: 8, text: '好。' });
  assert.equal(t.language, 'zh-TW');
});

test('a window whose coverage never completes fails after the rerun cap', async () => {
  const { calls, caller } = geminiDouble(
    Array.from({ length: 9 }, () => ({ text: 'LANGUAGE: en\n[00:00 - 00:04] still talking' })),
  );
  await assert.rejects(
    () => transcribeVideo('hWe-j78vNpc', deps(caller)),
    (err: unknown) => err instanceof TranscriptError && err.code === 'bad_model_output',
  );
  assert.equal(calls.length, 9);
});

test('a duration declared over the tenant limit fails before a second call', async () => {
  const { calls, caller } = geminiDouble([
    { text: 'DURATION: 500\nLANGUAGE: en\n[00:00 - 00:08] too long a video.' },
  ]);
  const d = { ...deps(caller), maxVideoSeconds: 100 };
  await assert.rejects(
    () => transcribeVideo('hWe-j78vNpc', d),
    (err: unknown) => err instanceof TranscriptError && err.code === 'video_too_long',
  );
  assert.equal(calls.length, 1);
});

test('coverage past the tenant limit fails even when no duration is declared', async () => {
  const w0 = [
    'LANGUAGE: en',
    '[00:00 - 00:08] a.',
    '[00:08 - 00:16] b.',
    '[00:16 - 00:24] c.',
    '[00:24 - 00:32] d.',
    '[00:32 - 00:40] e.',
  ].join('\n');
  const { calls, caller } = geminiDouble([
    { text: w0 },
    { text: 'LANGUAGE: en\n[00:00 - 00:08] still going.' },
  ]);
  const d = { ...deps(caller), maxVideoSeconds: 45 };
  await assert.rejects(
    () => transcribeVideo('hWe-j78vNpc', d),
    (err: unknown) => err instanceof TranscriptError && err.code === 'video_too_long',
  );
  assert.equal(calls.length, 2);
});

test('the window length is configurable', async () => {
  const { calls, caller } = geminiDouble([
    { text: 'LANGUAGE: en\n[00:00 - 00:08] short clip.' },
    { text: EMPTY },
  ]);
  const t = await transcribeVideo('hWe-j78vNpc', deps(caller, 16));
  assert.equal(calls.length, 2);
  assert.equal(calls[0].endOffsetSeconds, 16);
  assert.equal(calls[1].startOffsetSeconds, 16);
  assert.equal(calls[1].endOffsetSeconds, 32);
  assert.equal(t.blocks.length, 1);
});

test('usage metadata is logged for every Gemini call', async () => {
  const usage = { promptTokenCount: 1200, candidatesTokenCount: 80, totalTokenCount: 1400 };
  const { caller } = geminiDouble([
    { text: 'LANGUAGE: en\n[00:00 - 00:08] only block.', usage },
    { text: EMPTY, usage },
  ]);
  const logs: string[] = [];
  const d = { ...deps(caller), log: (line: string) => logs.push(line) };
  await transcribeVideo('hWe-j78vNpc', d);
  const lines = logs.filter((l) => l.startsWith('gemini_call'));
  assert.equal(lines.length, 2);
  for (const line of lines) {
    assert.ok(line.includes('video=hWe-j78vNpc'));
    assert.ok(line.includes('inputTokens=1200'));
    assert.ok(line.includes('outputTokens=80'));
    assert.ok(line.includes('totalTokens=1400'));
  }
});

for (const [label, last] of [
  ['English', 'It ends here.'],
  ['Chinese', '到此為止。'],
  ['Japanese', 'これで終わりですか？'],
  ['Hindi', 'यह अंत है।'],
  ['Arabic', 'هل هذه النهاية؟'],
  ['closing quote', 'He said “stop.”'],
] as const) {
  test(`a window ending in ${label} terminal punctuation completes without a tail rerun`, async () => {
    const { calls, caller } = geminiDouble([
      { text: `LANGUAGE: x\n[00:00 - 00:08] ${last}` },
      { text: 'LANGUAGE: x' },
    ]);
    await transcribeVideo('hWe-j78vNpc', deps(caller));
    assert.equal(calls.length, 2);
    // Call two is the next window's first call, not a rerun inside this one.
    assert.equal(calls[1].startOffsetSeconds, 40);
    assert.equal(calls[1].endOffsetSeconds, 80);
  });
}

test('a window tail left mid-sentence is rerun once; silence there stands', async () => {
  const { calls, caller } = geminiDouble([
    { text: 'LANGUAGE: th\n[00:00 - 00:08] สวัสดีครับทุกคน' },
    { text: 'LANGUAGE: th' },
    { text: 'LANGUAGE: th' },
  ]);
  const t = await transcribeVideo('hWe-j78vNpc', deps(caller));
  assert.equal(calls.length, 3);
  assert.equal(calls[1].startOffsetSeconds, 8);
  assert.equal(calls[1].endOffsetSeconds, 40);
  assert.equal(calls[2].startOffsetSeconds, 40);
  assert.equal(t.blocks.length, 1);
});
