import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { parse } from 'yaml';

// Guard for the one-line CLI (Issue 19): docker compose run --rm transcribe
// <url> must reach dist/cli.js, so the transcribe service overrides the
// image ENTRYPOINT. The api and bot services keep the image ENTRYPOINT/CMD.
const compose = parse(
  readFileSync(join(import.meta.dirname, '..', 'compose.yaml'), 'utf8'),
) as {
  services: Record<string, { entrypoint?: string[]; command?: string[] }>;
};

test('transcribe service entrypoint is the CLI', () => {
  assert.deepEqual(compose.services.transcribe.entrypoint, ['node', 'dist/cli.js']);
});

test('api and bot keep the image entrypoint', () => {
  assert.equal(compose.services.api.entrypoint, undefined);
  assert.equal(compose.services.bot.entrypoint, undefined);
  assert.deepEqual(compose.services.bot.command, ['dist/bot.js']);
});
