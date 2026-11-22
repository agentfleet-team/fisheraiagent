#!/usr/bin/env node
import { loadServiceConfig } from './config.js';
import { createDriveStore } from './drive.js';
import { codeOf } from './errors.js';
import { consoleSink, log } from './log.js';
import { createGeminiCaller } from './gemini.js';
import { createService } from './service.js';

try {
  const config = loadServiceConfig();
  const server = createService({
    callerFactory: (apiKey) => createGeminiCaller({ apiKey, model: config.model }),
    model: config.model,
    version: config.version,
    commit: config.commit,
    maxBlockSeconds: config.maxBlockSeconds,
    cacheDir: config.cacheDir,
    windowSeconds: config.windowSeconds,
    defaultMaxVideoSeconds: config.maxVideoSeconds,
    serviceToken: config.serviceToken,
    tenantsFile: config.tenantsFile,
    tenantsJson: config.tenantsJson,
    maxConcurrentJobsPerClient: config.maxConcurrentJobsPerClient,
    maxJobsPerHourPerClient: config.maxJobsPerHourPerClient,
    trustedProxies: config.trustedProxyIps,
    drive:
      config.googleCredentials !== undefined || config.googleCredentialsJson !== undefined
        ? createDriveStore({
            credentialsPath: config.googleCredentials,
            credentialsJson: config.googleCredentialsJson,
          })
        : undefined,
    oidc: config.oidc,
    log: consoleSink,
  });
  server.listen(config.port, () => {
    log('service_listening', { port: config.port });
  });
} catch (err) {
  log('startup_failed', { code: codeOf(err) });
  process.exitCode = 1;
}
