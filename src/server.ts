#!/usr/bin/env node
import { loadServiceConfig } from './config.js';
import { createDriveStore } from './drive.js';
import { TranscriptError } from './errors.js';
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
    tenantsFile: config.tenantsFile,
    drive: config.googleCredentials
      ? createDriveStore({ credentialsPath: config.googleCredentials })
      : undefined,
    log: (line) => console.log(line),
  });
  server.listen(config.port, () => {
    console.log(`transcript service listening on :${config.port}`);
  });
} catch (err) {
  if (err instanceof TranscriptError) {
    console.error(`${err.code}: ${err.message}`);
  } else {
    console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
  }
  process.exitCode = 1;
}
