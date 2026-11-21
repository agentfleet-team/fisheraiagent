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
  const store = new GuildStore(config.dataFile, deriveEncryptionKey(config.encryptionSecret));
  const api = createApiClient({
    baseUrl: config.apiBaseUrl,
    serviceToken: config.serviceToken,
    pollIntervalMs: config.pollIntervalMs,
    timeoutMs: config.jobTimeoutMs,
  });
  const core = createBot({ api, store, log: consoleSink });
  await startDiscordBot(config, core, consoleSink);
} catch (err) {
  log('startup_failed', { code: codeOf(err) });
  process.exitCode = 1;
}
