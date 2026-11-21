#!/usr/bin/env node
import { TranscriptError } from './errors.js';
import { parseYouTubeVideoId } from './youtube-url.js';
import { loadConfig } from './config.js';
import { createGeminiCaller } from './gemini.js';
import { transcribeYouTube } from './transcribe.js';

async function main(): Promise<number> {
  const input = process.argv[2];
  if (!input) {
    console.error('usage: transcribe <youtube-url-or-video-id>');
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
      log: (line) => console.error(line),
    });
    process.stdout.write(JSON.stringify(transcript, null, 2) + '\n');
    return 0;
  } catch (err) {
    if (err instanceof TranscriptError) {
      console.error(`${err.code}: ${err.message}`);
      return 1;
    }
    console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  }
}

process.exitCode = await main();
