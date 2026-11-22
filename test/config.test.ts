import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, loadServiceConfig } from '../src/config.js';
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
  assert.equal(cfg.maxVideoSeconds, 43200);

  const custom = loadConfig({
    ...base,
    GEMINI_MODEL: 'other-model',
    MAX_BLOCK_SECONDS: '5.5',
    CACHE_DIR: '/tmp/x',
    WINDOW_SECONDS: '90',
    MAX_VIDEO_SECONDS: '3600',
  });
  assert.equal(custom.model, 'other-model');
  assert.equal(custom.maxBlockSeconds, 5.5);
  assert.equal(custom.cacheDir, '/tmp/x');
  assert.equal(custom.windowSeconds, 90);
  assert.equal(custom.maxVideoSeconds, 3600);
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

test('invalid MAX_VIDEO_SECONDS fails with invalid_config', () => {
  for (const bad of ['abc', '0', '-5']) {
    assert.throws(
      () => loadConfig({ ...base, MAX_VIDEO_SECONDS: bad }),
      (err: unknown) => err instanceof TranscriptError && err.code === 'invalid_config',
      bad,
    );
  }
});

test('per-client limit env vars default and override', () => {
  const cfg = loadServiceConfig({});
  assert.equal(cfg.maxConcurrentJobsPerClient, 2);
  assert.equal(cfg.maxJobsPerHourPerClient, 20);
  assert.deepEqual(cfg.trustedProxyIps, ['127.0.0.1', '::1']);

  const custom = loadServiceConfig({
    MAX_CONCURRENT_JOBS_PER_CLIENT: '5',
    MAX_JOBS_PER_HOUR_PER_CLIENT: '100',
    TRUSTED_PROXY_IPS: ' 10.0.0.1, 10.1.0.0/16 , ::1 ',
  });
  assert.equal(custom.maxConcurrentJobsPerClient, 5);
  assert.equal(custom.maxJobsPerHourPerClient, 100);
  assert.deepEqual(custom.trustedProxyIps, ['10.0.0.1', '10.1.0.0/16', '::1']);

  assert.deepEqual(loadServiceConfig({ TRUSTED_PROXY_IPS: 'none' }).trustedProxyIps, []);
});

test('invalid per-client limit env vars fail with invalid_config', () => {
  for (const env of [
    { MAX_CONCURRENT_JOBS_PER_CLIENT: '0' },
    { MAX_CONCURRENT_JOBS_PER_CLIENT: 'abc' },
    { MAX_CONCURRENT_JOBS_PER_CLIENT: '1.5' },
    { MAX_JOBS_PER_HOUR_PER_CLIENT: '-2' },
    { TRUSTED_PROXY_IPS: 'not-an-ip' },
    { TRUSTED_PROXY_IPS: '10.0.0.0/33' },
    { TRUSTED_PROXY_IPS: '10.0.0.0/' },
  ]) {
    assert.throws(
      () => loadServiceConfig(env),
      (err: unknown) => err instanceof TranscriptError && err.code === 'invalid_config',
      JSON.stringify(env),
    );
  }
});
