#!/usr/bin/env node
import { resolveCaptionReader } from './captions-remote.js';
import { loadServiceConfig } from './config.js';
import { createDriveStore } from './drive.js';
import { codeOf } from './errors.js';
import { consoleSink, log } from './log.js';
import { createGeminiCaller } from './gemini.js';
import { createService } from './service.js';

try {
  const config = loadServiceConfig();
  // N2 mode: remote over the tunnel, local in-process on request, off —
  // no YouTube call at all — by default.
  const captions = resolveCaptionReader(config);
  const server = createService({
    callerFactory: (apiKey) => createGeminiCaller({ apiKey, model: config.model, log: consoleSink }),
    model: config.model,
    version: config.version,
    commit: config.commit,
    maxBlockSeconds: config.maxBlockSeconds,
    cacheDir: config.cacheDir,
    windowSeconds: config.windowSeconds,
    defaultMaxVideoSeconds: config.maxVideoSeconds,
    captionReader: captions?.reader,
    captionReadOrigin: captions?.origin,
    serviceToken: config.serviceToken,
    tenantsFile: config.tenantsFile,
    tenantsJson: config.tenantsJson,
    maxConcurrentJobsPerClient: config.maxConcurrentJobsPerClient,
    maxJobsPerHourPerClient: config.maxJobsPerHourPerClient,
    trustedProxies: config.trustedProxyIps,
    drive:
      config.googleCredentials !== undefined ||
      config.googleCredentialsJson !== undefined ||
      config.googleOauthJson !== undefined
        ? createDriveStore({
            credentialsPath: config.googleCredentials,
            credentialsJson: config.googleCredentialsJson,
            oauthJson: config.googleOauthJson,
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
