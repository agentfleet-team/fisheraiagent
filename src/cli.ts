#!/usr/bin/env node
import { codeOf } from './errors.js';
import { consoleSink, log } from './log.js';
import { parseYouTubeVideoId } from './youtube-url.js';
import { loadConfig } from './config.js';
import { createGeminiCaller } from './gemini.js';
import { transcribeYouTube } from './transcribe.js';

async function main(): Promise<number> {
  const input = process.argv[2];
  if (!input) {
    log('startup_failed', { code: 'usage' });
    return 2;
  }

  try {
    const videoId = parseYouTubeVideoId(input);
    const config = loadConfig();
    const caller = createGeminiCaller({ apiKey: config.apiKey, model: config.model });
    const transcript = await transcribeYouTube(videoId, {
      caller,
      model: config.model,
      maxBlockSeconds: config.maxBlockSeconds,
      cacheDir: config.cacheDir,
      log: consoleSink,
    });
    process.stdout.write(JSON.stringify(transcript, null, 2) + '\n');
    return 0;
  } catch (err) {
    const code = codeOf(err);
    log('startup_failed', { code });
    return code === 'internal_error' ? 2 : 1;
  }
}

process.exitCode = await main();
