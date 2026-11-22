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
    return { text: fixture('model-good.txt'), status: 'completed' };
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
  assert.equal(calls.length, 1);
  assert.equal(first.blocks.length, 5);
  assert.equal(readdirSync(cacheDir).length, 1);

  const second = await transcribeYouTube('hWe-j78vNpc', deps);
  assert.equal(calls.length, 1, 'cache hit must not call Gemini');
  assert.deepEqual(second, first);
  assert.ok(logs.includes('cache hit hWe-j78vNpc'));
});

test('different settings produce a different cache entry', async () => {
  const cacheDir = mkdtempSync(join(tmpdir(), 'fa-cache-'));
  const caller: GeminiCaller = async () => ({
    text: fixture('model-good.txt'),
    status: 'completed',
  });
  await transcribeYouTube('hWe-j78vNpc', { caller, model: 'm1', maxBlockSeconds: 8, cacheDir });
  await transcribeYouTube('hWe-j78vNpc', { caller, model: 'm2', maxBlockSeconds: 8, cacheDir });
  await transcribeYouTube('hWe-j78vNpc', { caller, model: 'm1', maxBlockSeconds: 10, cacheDir });
  assert.equal(readdirSync(cacheDir).length, 3);
});
