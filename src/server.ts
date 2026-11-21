#!/usr/bin/env node
import { loadServiceConfig } from './config.js';
import { codeOf } from './errors.js';
import { consoleSink, log } from './log.js';
import { createGeminiCaller } from './gemini.js';
import { createService } from './service.js';

try {
  const config = loadServiceConfig();
  const server = createService({
    callerFactory: (apiKey) => createGeminiCaller({ apiKey, model: config.model }),
    model: config.model,
    maxBlockSeconds: config.maxBlockSeconds,
    cacheDir: config.cacheDir,
    serviceToken: config.serviceToken,
    log: consoleSink,
  });
  server.listen(config.port, () => {
    log('service_listening', { port: config.port });
  });
} catch (err) {
  log('startup_failed', { code: codeOf(err) });
  process.exitCode = 1;
}
