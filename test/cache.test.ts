import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { transcribeYouTube } from '../src/transcribe.js';
import type { GeminiCaller, GeminiVideoRequest } from '../src/gemini.js';

const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

test('a second request for the same video and settings makes zero Gemini calls and logs cache hit', async () => {
  const cacheDir = mkdtempSync(join(tmpdir(), 'fa-cache-'));
  const calls: GeminiVideoRequest[] = [];
  const caller: GeminiCaller = async (req) => {
    calls.push(req);
    // A real video answers blocks for the first window and no speech for
    // any clip that starts later.
    const text = (req.startOffsetSeconds ?? 0) > 0 ? 'LANGUAGE: en' : fixture('model-good.txt');
    return { text, status: 'completed' };
  };
  const logs: string[] = [];
  const deps = {
    caller,
    model: 'test-model',
    maxBlockSeconds: 8,
    cacheDir,
    log: (line: string) => logs.push(line),
  };

  const first = await transcribeYouTube('hWe-j78vNpc', deps);
  assert.equal(calls.length, 2);
  assert.equal(first.blocks.length, 5);
  assert.equal(readdirSync(cacheDir).length, 1);

  const second = await transcribeYouTube('hWe-j78vNpc', deps);
  assert.equal(calls.length, 2, 'cache hit must not call Gemini');
  assert.deepEqual(second, first);
  assert.ok(logs.includes('cache_hit video=hWe-j78vNpc'));
});

test('different settings produce a different cache entry', async () => {
  const cacheDir = mkdtempSync(join(tmpdir(), 'fa-cache-'));
  const caller: GeminiCaller = async (req) => ({
    text: (req.startOffsetSeconds ?? 0) > 0 ? 'LANGUAGE: en' : fixture('model-good.txt'),
    status: 'completed',
  });
  await transcribeYouTube('hWe-j78vNpc', { caller, model: 'm1', maxBlockSeconds: 8, cacheDir });
  await transcribeYouTube('hWe-j78vNpc', { caller, model: 'm2', maxBlockSeconds: 8, cacheDir });
  await transcribeYouTube('hWe-j78vNpc', { caller, model: 'm1', maxBlockSeconds: 10, cacheDir });
  await transcribeYouTube('hWe-j78vNpc', {
    caller,
    model: 'm1',
    maxBlockSeconds: 8,
    cacheDir,
    windowSeconds: 60,
  });
  assert.equal(readdirSync(cacheDir).length, 4);
});

test('a different transcript format version is a cache miss; the same version is a hit', async () => {
  const cacheDir = mkdtempSync(join(tmpdir(), 'fa-cache-'));
  const calls: GeminiVideoRequest[] = [];
  const caller: GeminiCaller = async (req) => {
    calls.push(req);
    // A real video answers blocks for the first window and no speech for
    // any clip that starts later.
    const text = (req.startOffsetSeconds ?? 0) > 0 ? 'LANGUAGE: en' : fixture('model-good.txt');
    return { text, status: 'completed' };
  };
  const base = { caller, model: 'test-model', maxBlockSeconds: 8, cacheDir };

  await transcribeYouTube('hWe-j78vNpc', { ...base, formatVersion: 1 });
  assert.equal(calls.length, 2);

  // Same video, model and block length but a newer format version: the
  // old entry is a miss and the model is called again.
  await transcribeYouTube('hWe-j78vNpc', { ...base, formatVersion: 2 });
  assert.equal(calls.length, 4);
  assert.equal(readdirSync(cacheDir).length, 2);

  // The same version hits its own entry: no further call.
  await transcribeYouTube('hWe-j78vNpc', { ...base, formatVersion: 2 });
  assert.equal(calls.length, 4, 'cache hit must not call Gemini');

  // Old entries are never deleted: version 1 still hits its own file.
  await transcribeYouTube('hWe-j78vNpc', { ...base, formatVersion: 1 });
  assert.equal(calls.length, 4, 'old-format entry must still hit its own cache file');
});

test('a cache entry written under format version 2 is not served under the current version', async () => {
  const cacheDir = mkdtempSync(join(tmpdir(), 'fa-cache-'));
  const calls: GeminiVideoRequest[] = [];
  const caller: GeminiCaller = async (req) => {
    calls.push(req);
    const text = (req.startOffsetSeconds ?? 0) > 0 ? 'LANGUAGE: en' : fixture('model-good.txt');
    return { text, status: 'completed' };
  };
  const base = { caller, model: 'test-model', maxBlockSeconds: 8, cacheDir };

  await transcribeYouTube('hWe-j78vNpc', { ...base, formatVersion: 2 });
  assert.equal(calls.length, 2);
  assert.equal(readdirSync(cacheDir).length, 1);

  // No formatVersion override: the current TRANSCRIPT_FORMAT_VERSION must
  // miss the v2 entry, call the model again and write a second file.
  const result = await transcribeYouTube('hWe-j78vNpc', base);
  assert.equal(calls.length, 4, 'v2 cache entry must be a miss under the current format version');
  assert.equal(result.blocks.length, 5);
  assert.equal(readdirSync(cacheDir).length, 2);
});
