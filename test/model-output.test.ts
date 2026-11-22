import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ModelOutputError, parseModelOutput } from '../src/model-output.js';

const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

test('well-formed output parses to language and blocks', () => {
  const out = parseModelOutput(fixture('model-good.txt'), 8);
  assert.equal(out.language, 'en');
  assert.equal(out.blocks.length, 5);
  assert.deepEqual(out.blocks[0], {
    start: 0,
    end: 7,
    text: "There's this technique that I use all the time.",
  });
  assert.equal(out.blocks.at(-1)?.end, 39);
});

test('MM:SS and HH:MM:SS block times parse to seconds', () => {
  const out = parseModelOutput(
    'LANGUAGE: en\n[01:02 - 01:09] a\n[1:02:03 - 1:02:10] b',
    8,
  );
  assert.deepEqual(out.blocks[0], { start: 62, end: 69, text: 'a' });
  assert.deepEqual(out.blocks[1], { start: 3723, end: 3730, text: 'b' });
});

test('plain-second and fractional block times are still accepted', () => {
  const out = parseModelOutput('LANGUAGE: en\n[8 - 16] a\n[16.5 - 24] b', 8);
  assert.deepEqual(out.blocks[0], { start: 8, end: 16, text: 'a' });
  assert.deepEqual(out.blocks[1], { start: 16.5, end: 24, text: 'b' });
});

test('a header-only response parses empty only where empty ranges are allowed', () => {
  assert.throws(() => parseModelOutput('LANGUAGE: en', 8), ModelOutputError);
  const out = parseModelOutput('LANGUAGE: en', 8, { allowEmpty: true });
  assert.equal(out.language, 'en');
  assert.deepEqual(out.blocks, []);
  assert.throws(
    () => parseModelOutput('The video has no more speech.', 8, { allowEmpty: true }),
    ModelOutputError,
  );
});

test('non-monotonic block times are rejected', () => {
  assert.throws(() => parseModelOutput(fixture('model-nonmonotonic.txt'), 8), ModelOutputError);
});

test('a zero-length block at whole-second precision is accepted', () => {
  const out = parseModelOutput(
    'LANGUAGE: zh-TW\n[00:40 - 00:43] a\n[00:43 - 00:43] 好。\n[00:43 - 00:51] b',
    8,
  );
  assert.deepEqual(out.blocks[1], { start: 43, end: 43, text: '好。' });
});

test('a block that ends before it starts is still rejected', () => {
  assert.throws(
    () => parseModelOutput('LANGUAGE: en\n[00:44 - 00:43] x', 8),
    ModelOutputError,
  );
});

test('a block longer than the limit is rejected', () => {
  assert.throws(() => parseModelOutput(fixture('model-overlong.txt'), 8), /exceeds 8s limit/);
});

test('allowOverLimitBlocks reports the over-limit spans and keeps the other checks strict', () => {
  const raw = 'LANGUAGE: en\n[00:00 - 00:08] a\n[00:08 - 00:19] b\n[00:19 - 00:30] c';
  assert.throws(() => parseModelOutput(raw, 8), /exceeds 8s limit/);
  const out = parseModelOutput(raw, 8, { allowOverLimitBlocks: true });
  assert.deepEqual(out.overLimit, { count: 2, longestSeconds: 11 });
  assert.equal(out.blocks.length, 3);
  const unordered = 'LANGUAGE: en\n[00:08 - 00:19] b\n[00:00 - 00:08] a';
  assert.throws(
    () => parseModelOutput(unordered, 8, { allowOverLimitBlocks: true }),
    /before the previous block start/,
  );
});

test('output with no transcript blocks is rejected', () => {
  assert.throws(() => parseModelOutput(fixture('model-garbage.txt'), 8), ModelOutputError);
});

test('code fences and preamble lines are tolerated', () => {
  const text = [
    'Here is the transcript:',
    '```',
    'LANGUAGE: zh-TW',
    '[00:00 - 00:08] 你好',
    '[00:08 - 00:16] 世界',
    '```',
  ].join('\n');
  const out = parseModelOutput(text, 8);
  assert.equal(out.language, 'zh-TW');
  assert.equal(out.blocks.length, 2);
});

test('a continuation line is joined to the previous block', () => {
  const text = ['LANGUAGE: en', '[00:00 - 00:08] first part', 'of the same sentence'].join('\n');
  const out = parseModelOutput(text, 8);
  assert.equal(out.blocks[0].text, 'first part of the same sentence');
});

test('a timestamp component out of range is rejected', () => {
  for (const bad of ['[00:60 - 01:07] x', '[1:60:00 - 1:60:07] x', '[75:00 - 75:07] x']) {
    assert.throws(() => parseModelOutput(`LANGUAGE: en\n${bad}`, 8), ModelOutputError);
  }
});

test('hour rollover and fractional seconds parse', () => {
  const out = parseModelOutput('LANGUAGE: en\n[59:56 - 1:00:04] a\n[01:00:04 - 01:00:11.5] b', 8);
  assert.deepEqual(out.blocks.map((b) => [b.start, b.end]), [[3596, 3604], [3604, 3611.5]]);
});

test('a malformed block line is rejected, not absorbed as text or preamble', () => {
  assert.throws(
    () => parseModelOutput('LANGUAGE: en\n[00:00 - 00:08] a\n[00:08 - broken] b', 8),
    ModelOutputError,
  );
  assert.throws(
    () => parseModelOutput('LANGUAGE: en\n[broken - 00:08] b\n[00:08 - 00:16] c', 8),
    ModelOutputError,
  );
});

test('any bracket-led line with a time-like token must parse fully as a range block', () => {
  for (const bad of [
    '［00:08 - 00:16］ full-width brackets',
    '［00:08 - 00:16] mixed opening bracket',
    '[00:08 - 00:16］ mixed closing bracket',
    '[00：08 - 00：16] full-width colons',
    '[00:08 - ] missing end',
    '[00:08] missing end without separator',
    '[00:08 - 00:16 missing closing bracket',
    '[-00:08 - 00:16] negative start',
    '[00:08 - -00:16] negative end',
    '[00:-08 - 00:16] negative component',
    '[broken - 00:16] non-numeric start',
    '[00:08 - NaN] non-numeric end',
    '[00:08 - 00:16 - 00:24] extra range field',
    '[00:00:00:08 - 00:00:00:16] extra colon component',
    '[00:08 - 00:16, 00:24] extra comma field',
  ]) {
    for (const position of ['before', 'after']) {
      const valid = '[00:00 - 00:08] a';
      const raw = `LANGUAGE: en\n${position === 'before' ? `${bad}\n${valid}` : `${valid}\n${bad}`}`;
      assert.throws(() => parseModelOutput(raw, 8), ModelOutputError, bad);
    }
  }
});

test('bracket-led lines without a time-like token stay text', () => {
  const out = parseModelOutput(
    'LANGUAGE: en\n[music]\n[00:00 - 00:08] a\n【拍手】\n[laughter]',
    8,
  );
  assert.equal(out.blocks[0].text, 'a 【拍手】 [laughter]');
});
