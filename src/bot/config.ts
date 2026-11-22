import { TranscriptError } from '../errors.js';

export interface BotConfig {
  discordToken: string;
  encryptionSecret: string;
  apiBaseUrl: string;
  serviceToken?: string;
  dataFile: string;
  pollIntervalMs: number;
  jobTimeoutMs: number;
}

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
  const encryptionSecret = (env.BOT_ENCRYPTION_KEY ?? '').trim();
  if (!encryptionSecret) {
    throw new TranscriptError('invalid_config', 'BOT_ENCRYPTION_KEY is not set');
  }
  return {
    discordToken,
    encryptionSecret,
    apiBaseUrl: (env.API_BASE_URL ?? '').trim() || DEFAULT_API_BASE_URL,
    serviceToken: (env.SERVICE_TOKEN ?? '').trim() || undefined,
    dataFile: (env.BOT_DATA_FILE ?? '').trim() || DEFAULT_DATA_FILE,
    pollIntervalMs: positiveMs(env, 'BOT_POLL_INTERVAL_MS', DEFAULT_POLL_INTERVAL_MS),
    jobTimeoutMs: positiveMs(env, 'BOT_JOB_TIMEOUT_MS', DEFAULT_JOB_TIMEOUT_MS),
  };
}
