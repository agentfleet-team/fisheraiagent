#!/usr/bin/env node
import { loadServiceConfig } from '../config.js';
import { saveDriveFromConfig } from '../drive-save.js';
import { codeOf } from '../errors.js';
import { log } from '../log.js';
import { createGeminiDigestLlm } from './llm.js';
import { createDigestService } from './service.js';

// The digest tool's entry point: `node dist/digest/server.js`. The same
// environment variables as the transcript service apply (PORT,
// SERVICE_TOKEN, GEMINI_MODEL, TENANTS_FILE, TENANTS_JSON).
// With one of GOOGLE_APPLICATION_CREDENTIALS, GOOGLE_CREDENTIALS_JSON or
// GOOGLE_OAUTH_JSON set, the save node writes to the tenant's Drive folder;
// with none set it stays off.
try {
  const config = loadServiceConfig();
  const server = createDigestService({
    llmFactory: (apiKey) => createGeminiDigestLlm({ apiKey, model: config.model }),
    drive: saveDriveFromConfig(config),
    serviceToken: config.serviceToken,
    tenantsFile: config.tenantsFile,
    tenantsJson: config.tenantsJson,
  });
  server.listen(config.port, () => {
    log('service_listening', { port: config.port });
  });
} catch (err) {
  log('startup_failed', { code: codeOf(err) });
  process.exitCode = 1;
}
