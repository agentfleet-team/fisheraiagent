import { TranscriptError } from '../errors.js';
import { parseChannelId, parseGuildId } from '../ids.js';
import type { TenantChannels } from './core.js';

// Tenant listener mode: the caller token the bot submits jobs with (sent as
// the /v1 bearer — the same credential the resolved tenant's caller check
// names) plus the channels it answers in. No per-guild key and no data file.
export interface TenantListener extends TenantChannels {
  callerToken: string;
}

interface BotConfigBase {
  discordToken: string;
  apiBaseUrl: string;
  serviceToken?: string;
  pollIntervalMs: number;
  jobTimeoutMs: number;
}

export type BotConfig =
  // BYOK mode: per-guild keys and channel enablement live in the data file.
  | (BotConfigBase & { tenant?: undefined; encryptionSecret: string; dataFile: string })
  // Tenant listener mode: channels and the caller credential are config.
  | (BotConfigBase & { tenant: TenantListener });

const DEFAULT_API_BASE_URL = 'http://localhost:8080';
const DEFAULT_DATA_FILE = './bot-data/bot-data.json';
const DEFAULT_POLL_INTERVAL_MS = 2000;
const DEFAULT_JOB_TIMEOUT_MS = 30 * 60 * 1000;

function positiveMs(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
): number {
  const raw = (env[name] ?? '').trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new TranscriptError('invalid_config', `${name} must be a positive number, got: ${raw}`);
  }
  return value;
}

export function loadBotConfig(env: NodeJS.ProcessEnv = process.env): BotConfig {
  const discordToken = (env.DISCORD_TOKEN ?? '').trim();
  if (!discordToken) {
    throw new TranscriptError('invalid_config', 'DISCORD_TOKEN is not set');
  }
  const base: BotConfigBase = {
    discordToken,
    apiBaseUrl: (env.API_BASE_URL ?? '').trim() || DEFAULT_API_BASE_URL,
    serviceToken: (env.SERVICE_TOKEN ?? '').trim() || undefined,
    pollIntervalMs: positiveMs(env, 'BOT_POLL_INTERVAL_MS', DEFAULT_POLL_INTERVAL_MS),
    jobTimeoutMs: positiveMs(env, 'BOT_JOB_TIMEOUT_MS', DEFAULT_JOB_TIMEOUT_MS),
  };
  const callerToken = (env.TENANT_CALLER_TOKEN ?? '').trim();
  const guild = (env.TENANT_GUILD_ID ?? '').trim();
  const channelList = (env.TENANT_CHANNEL_IDS ?? '').trim();
  if (callerToken === '' && guild === '' && channelList === '') {
    const encryptionSecret = (env.BOT_ENCRYPTION_KEY ?? '').trim();
    if (!encryptionSecret) {
      throw new TranscriptError('invalid_config', 'BOT_ENCRYPTION_KEY is not set');
    }
    return {
      ...base,
      encryptionSecret,
      dataFile: (env.BOT_DATA_FILE ?? '').trim() || DEFAULT_DATA_FILE,
    };
  }
  if (callerToken === '') {
    throw new TranscriptError(
      'invalid_config',
      'TENANT_CALLER_TOKEN is required when TENANT_GUILD_ID or TENANT_CHANNEL_IDS is set',
    );
  }
  const guildId = parseGuildId(guild);
  if (guildId === undefined) {
    throw new TranscriptError('invalid_config', 'TENANT_GUILD_ID must be a Discord snowflake');
  }
  const channelIds = channelList
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id !== '');
  if (channelIds.length === 0) {
    throw new TranscriptError(
      'invalid_config',
      'TENANT_CHANNEL_IDS must list at least one channel id',
    );
  }
  for (const id of channelIds) {
    if (parseChannelId(id) === undefined) {
      throw new TranscriptError('invalid_config', `TENANT_CHANNEL_IDS: ${id} is not a Discord snowflake`);
    }
  }
  return { ...base, tenant: { callerToken, guildId, channelIds } };
}
