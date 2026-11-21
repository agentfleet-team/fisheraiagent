import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { transcribeVideo, type TranscribeDeps } from '../src/transcribe.js';
import type { GeminiCaller, GeminiVideoRequest, GeminiVideoResponse } from '../src/gemini.js';
import { TranscriptError } from '../src/errors.js';

const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

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
    const res: GeminiVideoResponse = { text: next.text ?? '', status: next.status ?? 'completed' };
    return res;
  };
  return { calls, caller };
}

function deps(caller: GeminiCaller): TranscribeDeps {
  return {
    caller,
    model: 'test-model',
    maxBlockSeconds: 8,
    cacheDir: mkdtempSync(join(tmpdir(), 'fa-cache-')),
  };
}

test('output that stops before the video end re-requests the missing range and merges', async () => {
  const { calls, caller } = geminiDouble([
    { text: fixture('model-truncated-part1.txt') },
    { text: fixture('model-truncated-part2.txt') },
  ]);
  const t = await transcribeVideo('hWe-j78vNpc', deps(caller));

  assert.equal(calls.length, 2);
  assert.equal(calls[0].startOffsetSeconds, undefined);
  assert.equal(calls[1].startOffsetSeconds, 40);
  assert.equal(t.blocks.length, 13);
  assert.equal(t.blocks[0].start, 0);
  assert.equal(t.blocks.at(-1)?.end, 100);
  assert.equal(t.language, 'en');
  assert.equal(t.video_id, 'hWe-j78vNpc');
});

test('an incomplete interaction status also triggers a range continuation', async () => {
  const part1 = ['LANGUAGE: en', '[0.0 - 8.0] only block'].join('\n');
  const part2 = fixture('model-truncated-part2.txt');
  const { calls, caller } = geminiDouble([
    { text: part1, status: 'incomplete' },
    { text: part2 },
  ]);
  const t = await transcribeVideo('hWe-j78vNpc', deps(caller));
  assert.equal(calls.length, 2);
  assert.equal(calls[1].startOffsetSeconds, 8);
  assert.equal(t.blocks.length, 9);
});

test('bad model output is retried once, then fails with bad_model_output', async () => {
  const { calls, caller } = geminiDouble([
    { text: fixture('model-garbage.txt') },
    { text: fixture('model-garbage.txt') },
    { text: fixture('model-good.txt') },
  ]);
  await assert.rejects(
    () => transcribeVideo('hWe-j78vNpc', deps(caller)),
    (err: unknown) => err instanceof TranscriptError && err.code === 'bad_model_output',
  );
  assert.equal(calls.length, 2);
});

test('the strict retry recovers a one-off bad response', async () => {
  const { calls, caller } = geminiDouble([
    { text: fixture('model-garbage.txt') },
    { text: fixture('model-good.txt') },
  ]);
  const t = await transcribeVideo('hWe-j78vNpc', deps(caller));
  assert.equal(calls.length, 2);
  assert.equal(t.blocks.length, 5);
});

test('a range request rejected with 400 ends the video instead of failing', async () => {
  const err = new TranscriptError('video_unavailable', 'INVALID_ARGUMENT: start_offset past end', {
    httpStatus: 400,
  });
  const { calls, caller } = geminiDouble([
    { text: fixture('model-truncated-part1.txt') },
    { error: err },
  ]);
  const t = await transcribeVideo('hWe-j78vNpc', deps(caller));
  assert.equal(calls.length, 2);
  assert.equal(t.blocks.at(-1)?.end, 40);
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
