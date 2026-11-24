#!/usr/bin/env node
import { codeOf } from './errors.js';
import { consoleSink, log } from './log.js';
import { createApiClient } from './bot/api.js';
import { loadBotConfig } from './bot/config.js';
import { createBot } from './bot/core.js';
import { deriveEncryptionKey } from './bot/crypto.js';
import { startDiscordBot } from './bot/discord.js';
import { GuildStore } from './bot/store.js';

try {
  const config = loadBotConfig();
  // Tenant listener mode submits with the caller token as the /v1 bearer;
  // BYOK mode uses the shared service token when the API requires one.
  const api = createApiClient({
    baseUrl: config.apiBaseUrl,
    serviceToken: config.tenant === undefined ? config.serviceToken : config.tenant.callerToken,
    pollIntervalMs: config.pollIntervalMs,
    timeoutMs: config.jobTimeoutMs,
  });
  const core =
    config.tenant === undefined
      ? createBot({
          api,
          store: new GuildStore(config.dataFile, deriveEncryptionKey(config.encryptionSecret)),
          log: consoleSink,
        })
      : createBot({ api, tenant: config.tenant, log: consoleSink });
  await startDiscordBot(config, core, consoleSink);
} catch (err) {
  log('startup_failed', { code: codeOf(err) });
  process.exitCode = 1;
}
