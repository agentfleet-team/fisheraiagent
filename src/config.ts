import { readFileSync } from 'node:fs';
import { TranscriptError } from './errors.js';

export interface Config {
  apiKey: string;
  model: string;
  maxBlockSeconds: number;
  cacheDir: string;
}

export interface ServiceConfig {
  port: number;
  model: string;
  maxBlockSeconds: number;
  cacheDir: string;
  serviceToken?: string;
}

const DEFAULT_MAX_BLOCK_SECONDS = 8;
const DEFAULT_CACHE_DIR = './transcript-cache';
const DEFAULT_PORT = 8080;

function defaultModel(): string {
  const pkg: { config?: { geminiModel?: string } } = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  );
  const model = pkg.config?.geminiModel;
  if (!model) throw new TranscriptError('invalid_config', 'no default model in package.json config.geminiModel');
  return model;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const apiKey = (env.GEMINI_API_KEY ?? '').trim();
  if (!apiKey) {
    throw new TranscriptError('missing_key', 'GEMINI_API_KEY is not set');
  }

  const model = (env.GEMINI_MODEL ?? '').trim() || defaultModel();

  let maxBlockSeconds = DEFAULT_MAX_BLOCK_SECONDS;
  const rawMax = (env.MAX_BLOCK_SECONDS ?? '').trim();
  if (rawMax) {
    maxBlockSeconds = Number(rawMax);
    if (!Number.isFinite(maxBlockSeconds) || maxBlockSeconds <= 0) {
      throw new TranscriptError('invalid_config', `MAX_BLOCK_SECONDS must be a positive number, got: ${rawMax}`);
    }
  }

  const cacheDir = (env.CACHE_DIR ?? '').trim() || DEFAULT_CACHE_DIR;

  return { apiKey, model, maxBlockSeconds, cacheDir };
}

// Service config: no GEMINI_API_KEY. Callers bring their own key per request.
export function loadServiceConfig(env: NodeJS.ProcessEnv = process.env): ServiceConfig {
  const model = (env.GEMINI_MODEL ?? '').trim() || defaultModel();

  let maxBlockSeconds = DEFAULT_MAX_BLOCK_SECONDS;
  const rawMax = (env.MAX_BLOCK_SECONDS ?? '').trim();
  if (rawMax) {
    maxBlockSeconds = Number(rawMax);
    if (!Number.isFinite(maxBlockSeconds) || maxBlockSeconds <= 0) {
      throw new TranscriptError('invalid_config', `MAX_BLOCK_SECONDS must be a positive number, got: ${rawMax}`);
    }
  }

  const cacheDir = (env.CACHE_DIR ?? '').trim() || DEFAULT_CACHE_DIR;

  let port = DEFAULT_PORT;
  const rawPort = (env.PORT ?? '').trim();
  if (rawPort) {
    port = Number(rawPort);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      throw new TranscriptError('invalid_config', `PORT must be an integer 1-65535, got: ${rawPort}`);
    }
  }

  const serviceToken = (env.SERVICE_TOKEN ?? '').trim() || undefined;

  return { port, model, maxBlockSeconds, cacheDir, serviceToken };
}
