import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

// Guard for the one-line CLI (Issue 19): docker compose run --rm transcribe
// <url> must reach dist/cli.js, so the transcribe service overrides the
// image ENTRYPOINT. The api and bot services keep the image ENTRYPOINT/CMD.
// Read as text: service blocks are the keys at two-space indent under
// `services:` (the file's only top-level key), so no YAML dependency.
const blocks = new Map<string, string[]>();
let current: string[] | undefined;
for (const line of readFileSync(
  join(import.meta.dirname, '..', 'compose.yaml'),
  'utf8',
).split('\n')) {
  const service = /^  ([A-Za-z0-9_-]+):/.exec(line);
  if (service) {
    current = [];
    blocks.set(service[1], current);
  } else if (current) {
    current.push(line);
  }
}

const entrypoint = (service: string) =>
  blocks.get(service)?.find((line) => /^\s+entrypoint:/.test(line));

test('transcribe service entrypoint is the CLI', () => {
  assert.equal(
    entrypoint('transcribe')?.trim(),
    'entrypoint: ["node", "dist/cli.js"]',
  );
});

test('api and bot keep the image entrypoint', () => {
  assert.equal(entrypoint('api'), undefined);
  assert.equal(entrypoint('bot'), undefined);
  assert.ok(
    blocks.get('bot')?.some((line) => line.trim() === 'command: ["dist/bot.js"]'),
  );
});

// Issue #46: the image bakes APP_VERSION/APP_COMMIT in at build time —
// the Dockerfile declares both build args with the dev defaults and turns
// them into runtime env, and every compose service's build passes them
// through from the shared x-build-args block. Read as text like above.
const composeText = readFileSync(join(import.meta.dirname, '..', 'compose.yaml'), 'utf8');
const dockerfile = readFileSync(join(import.meta.dirname, '..', 'Dockerfile'), 'utf8');

test('Dockerfile bakes the build identity in with dev defaults', () => {
  assert.match(dockerfile, /^ARG APP_VERSION=0\.0\.0-dev$/m);
  assert.match(dockerfile, /^ARG APP_COMMIT=unknown$/m);
  assert.match(dockerfile, /^ENV APP_VERSION=\$\{APP_VERSION\} APP_COMMIT=\$\{APP_COMMIT\}$/m);
});

test('every compose service builds with the shared build args', () => {
  assert.match(composeText, /APP_VERSION: \$\{APP_VERSION:-0\.0\.0-dev\}/);
  assert.match(composeText, /APP_COMMIT: \$\{APP_COMMIT:-unknown\}/);
  for (const service of ['api', 'bot', 'mcp', 'transcribe']) {
    assert.ok(
      blocks.get(service)?.some((line) => line.trim() === 'build: *build-args'),
      `${service} does not use the shared build args`,
    );
  }
});
