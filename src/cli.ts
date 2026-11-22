#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { codeOf } from './errors.js';
import { createLogger, stderrSink } from './log.js';
import { parseYouTubeVideoId } from './youtube-url.js';
import { loadConfig } from './config.js';
import { createGeminiCaller, type GeminiCaller } from './gemini.js';
import { transcribeYouTube } from './transcribe.js';

// The CLI's only stdout output is the transcript JSON, so its log sink is
// stderr; the api and bot services keep consoleSink.
const log = createLogger(stderrSink);

export async function main(input: string | undefined, caller?: GeminiCaller): Promise<number> {
  if (!input) {
    log('startup_failed', { code: 'usage' });
    return 2;
  }

  try {
    const videoId = parseYouTubeVideoId(input);
    const config = loadConfig();
    const transcript = await transcribeYouTube(videoId, {
      caller: caller ?? createGeminiCaller({ apiKey: config.apiKey, model: config.model }),
      model: config.model,
      maxBlockSeconds: config.maxBlockSeconds,
      cacheDir: config.cacheDir,
      windowSeconds: config.windowSeconds,
      defaultMaxVideoSeconds: config.maxVideoSeconds,
      log: stderrSink,
    });
    process.stdout.write(JSON.stringify(transcript, null, 2) + '\n');
    return 0;
  } catch (err) {
    const code = codeOf(err);
    log('startup_failed', { code });
    return code === 'internal_error' ? 2 : 1;
  }
}

// Run only as the entry point; tests import main with a stubbed caller.
if (process.argv[1] !== undefined && process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv[2]);
}
