import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';
import { TranscriptError } from '../src/errors.js';

const base = { GEMINI_API_KEY: 'test-key' };

test('missing GEMINI_API_KEY fails with missing_key', () => {
  assert.throws(
    () => loadConfig({}),
    (err: unknown) => err instanceof TranscriptError && err.code === 'missing_key',
  );
  assert.throws(
    () => loadConfig({ GEMINI_API_KEY: '   ' }),
    (err: unknown) => err instanceof TranscriptError && err.code === 'missing_key',
  );
});

test('defaults come from config, environment overrides them', () => {
  const cfg = loadConfig({ ...base });
  assert.equal(cfg.model, 'gemini-3.8-flash');
  assert.equal(cfg.maxBlockSeconds, 8);
  assert.equal(cfg.cacheDir, './transcript-cache');
  assert.equal(cfg.windowSeconds, 120);

  const custom = loadConfig({
    ...base,
    GEMINI_MODEL: 'other-model',
    MAX_BLOCK_SECONDS: '5.5',
    CACHE_DIR: '/tmp/x',
    WINDOW_SECONDS: '90',
  });
  assert.equal(custom.model, 'other-model');
  assert.equal(custom.maxBlockSeconds, 5.5);
  assert.equal(custom.cacheDir, '/tmp/x');
  assert.equal(custom.windowSeconds, 90);
});

test('invalid MAX_BLOCK_SECONDS fails with invalid_config', () => {
  assert.throws(
    () => loadConfig({ ...base, MAX_BLOCK_SECONDS: 'abc' }),
    (err: unknown) => err instanceof TranscriptError && err.code === 'invalid_config',
  );
});

test('invalid WINDOW_SECONDS fails with invalid_config', () => {
  for (const bad of ['abc', '0', '-5']) {
    assert.throws(
      () => loadConfig({ ...base, WINDOW_SECONDS: bad }),
      (err: unknown) => err instanceof TranscriptError && err.code === 'invalid_config',
      bad,
    );
  }
});
