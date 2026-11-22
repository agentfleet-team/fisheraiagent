import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

// Issue 21: the CLI's log sink is stderr, so a `> transcript.json` redirect
// captures a valid JSON document even when log lines are emitted. The runs go
// through a real child process so stdout and stderr are checked as streams.

const execFileAsync = promisify(execFile);
const ROOT = join(import.meta.dirname, '..');
const DRIVER = join(ROOT, 'test', 'fixtures', 'cli-driver.ts');
const VIDEO_URL = 'https://www.youtube.com/watch?v=hWe-j78vNpc';
const VIDEO_ID = 'hWe-j78vNpc';

function runCli(cacheDir: string) {
  return execFileAsync(process.execPath, ['--import', 'tsx', DRIVER, VIDEO_URL], {
    cwd: ROOT,
    env: {
      ...process.env,
      GEMINI_API_KEY: 'test-key',
      GEMINI_MODEL: 'test-model',
      CACHE_DIR: cacheDir,
    },
  });
}

test('CLI stdout is one JSON document; the second run logs cache_hit to stderr', async () => {
  const cacheDir = mkdtempSync(join(tmpdir(), 'fa-cli-cache-'));

  const miss = await runCli(cacheDir);
  const doc = JSON.parse(miss.stdout);
  assert.equal(doc.video_id, VIDEO_ID);
  assert.equal(doc.blocks.length, 5);

  const hit = await runCli(cacheDir);
  assert.deepEqual(JSON.parse(hit.stdout), doc);
  assert.ok(hit.stderr.includes(`cache_hit video=${VIDEO_ID}`));
});
