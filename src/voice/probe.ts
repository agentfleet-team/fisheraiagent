#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseVoiceRequest } from './contract.js';
import { edgeEngine } from './engine.js';
import { renderEpisode } from './render.js';

// `npm run voice:probe`: one live render of a two-section fixture with the
// real Edge endpoint. It writes the MP3 and the marks under voice-probe-out/
// (git-ignored) and prints the duration and the mark count. It needs network
// access and no key. It saves nothing to Drive.
const request = parseVoiceRequest({
  date: '2026-11-28',
  voice: { engine: 'edge', name: 'zh-TW-HsiaoChenNeural', rate: '-12%' },
  sections: [
    { id: 'opening', text: '早安，歡迎收聽今天的晨間節目。今天我們用幾十秒，試一下聲音和時間標記。先從第一件開始。' },
    { id: 'closing', text: '以上就是這次的測試內容。謝謝收聽，明天見。' },
  ],
  expect_seconds: { min: 5, max: 90 },
});
if (request === undefined) throw new Error('probe fixture is not a valid VoiceRequest');

const started = Date.now();
const { audio, result } = await renderEpisode(request, { engine: edgeEngine });
const dir = 'voice-probe-out';
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, `${request.date}-episode.mp3`), audio);
writeFileSync(join(dir, `${request.date}-marks.json`), `${JSON.stringify(result.marks, null, 2)}\n`);
process.stdout.write(
  `${JSON.stringify({
    duration_s: result.duration_s,
    bytes: result.bytes,
    sha256: result.sha256,
    marks: result.marks.length,
    sections: [...new Set(result.marks.map((m) => m.section_id))],
    wall_s: Math.round((Date.now() - started) / 100) / 10,
    out: dir,
  })}\n`,
);
