#!/usr/bin/env node
import { TranscriptError } from './errors.js';
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
  const core = createBot({ api, store, log: (line) => console.log(line) });
  await startDiscordBot(config, core, (line) => console.log(line));
} catch (err) {
  if (err instanceof TranscriptError) {
    console.error(`${err.code}: ${err.message}`);
  } else {
    console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
  }
  process.exitCode = 1;
}
