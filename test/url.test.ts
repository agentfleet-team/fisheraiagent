import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseYouTubeVideoId } from '../src/youtube-url.js';
import { TranscriptError } from '../src/errors.js';

const VIDEO_ID = 'hWe-j78vNpc';

test('common YouTube URL shapes parse to the same video_id', () => {
  const inputs = [
    'https://www.youtube.com/watch?v=hWe-j78vNpc',
    'https://youtu.be/hWe-j78vNpc?si=abc123xyz',
    'https://www.youtube.com/shorts/hWe-j78vNpc',
    'hWe-j78vNpc',
  ];
  for (const input of inputs) {
    assert.equal(parseYouTubeVideoId(input), VIDEO_ID, input);
  }
});

test('watch URL with extra params still parses', () => {
  assert.equal(
    parseYouTubeVideoId('https://www.youtube.com/watch?v=hWe-j78vNpc&t=42s&list=PLxyz'),
    VIDEO_ID,
  );
  assert.equal(parseYouTubeVideoId('https://m.youtube.com/watch?v=hWe-j78vNpc'), VIDEO_ID);
  assert.equal(parseYouTubeVideoId('https://www.youtube.com/embed/hWe-j78vNpc'), VIDEO_ID);
});

test('non-YouTube and malformed inputs are rejected with invalid_url', () => {
  const inputs = [
    'https://example.com/watch?v=hWe-j78vNpc',
    'not a url at all',
    'https://www.youtube.com/watch?v=tooshort',
  ];
  for (const input of inputs) {
    assert.throws(
      () => parseYouTubeVideoId(input),
      (err: unknown) => err instanceof TranscriptError && err.code === 'invalid_url',
      input,
    );
  }
});
