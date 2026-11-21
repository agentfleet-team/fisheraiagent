import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ModelOutputError, parseModelOutput } from '../src/model-output.js';

const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

test('well-formed output parses to duration, language and blocks', () => {
  const out = parseModelOutput(fixture('model-good.txt'), 8);
  assert.equal(out.durationSeconds, 534);
  assert.equal(out.language, 'en');
  assert.equal(out.blocks.length, 5);
  assert.deepEqual(out.blocks[0], {
    start: 0,
    end: 7.48,
    text: "There's this technique that I use all the time.",
  });
  assert.equal(out.blocks.at(-1)?.end, 534);
});

test('non-monotonic block times are rejected', () => {
  assert.throws(() => parseModelOutput(fixture('model-nonmonotonic.txt'), 8), ModelOutputError);
});

test('a block longer than the limit is rejected', () => {
  assert.throws(() => parseModelOutput(fixture('model-overlong.txt'), 8), /exceeds 8s limit/);
});

test('output with no transcript blocks is rejected', () => {
  assert.throws(() => parseModelOutput(fixture('model-garbage.txt'), 8), ModelOutputError);
});

test('code fences and preamble lines are tolerated', () => {
  const text = [
    'Here is the transcript:',
    '```',
    'DURATION: 20',
    'LANGUAGE: zh-TW',
    '[0.0 - 8.0] 你好',
    '[8.0 - 16.0] 世界',
    '```',
  ].join('\n');
  const out = parseModelOutput(text, 8);
  assert.equal(out.language, 'zh-TW');
  assert.equal(out.blocks.length, 2);
});

test('a continuation line is joined to the previous block', () => {
  const text = ['LANGUAGE: en', '[0.0 - 8.0] first part', 'of the same sentence'].join('\n');
  const out = parseModelOutput(text, 8);
  assert.equal(out.blocks[0].text, 'first part of the same sentence');
});
