import { readFileSync } from 'node:fs';
import {
  DEFAULT_MAX_CONCURRENT_JOBS_PER_CLIENT,
  DEFAULT_MAX_JOBS_PER_HOUR_PER_CLIENT,
  parseTrustedProxyIps,
} from './client-limit.js';
import { TranscriptError } from './errors.js';

export interface Config {
  apiKey: string;
  model: string;
  maxBlockSeconds: number;
  cacheDir: string;
  windowSeconds: number;
  maxVideoSeconds: number;
}

export interface ServiceConfig {
  port: number;
  model: string;
  maxBlockSeconds: number;
  cacheDir: string;
  windowSeconds: number;
  maxVideoSeconds: number;
  serviceToken?: string;
  tenantsFile?: string;
  tenantsJson?: string;
  // Per-client job-creation limits for the anonymous surface (no
  // SERVICE_TOKEN): in-flight jobs per client and accepted submissions
  // per client per sliding hour.
  maxConcurrentJobsPerClient: number;
  maxJobsPerHourPerClient: number;
  // Peers that may supply the client IP via CF-Connecting-IP (the
  // Cloudflare Tunnel's connector); a request from anywhere else is keyed
  // on its socket address.
  trustedProxyIps: string[];
  googleCredentials?: string;
  googleCredentialsJson?: string;
  oidc?: {
    clientId: string;
    clientSecret: string;
    issuer: string;
    redirectUri: string;
    sessionSecret: string;
  };
}

const DEFAULT_MAX_BLOCK_SECONDS = 8;
export const DEFAULT_WINDOW_SECONDS = 120;
// The length bound for a video no per-tenant cap covers, applied inside
// the window loop: a caller that never reports silence still fails with
// video_too_long instead of requesting windows without end. 12 hours is
// YouTube's documented maximum upload length.
export const DEFAULT_MAX_VIDEO_SECONDS = 12 * 60 * 60;
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

  let windowSeconds = DEFAULT_WINDOW_SECONDS;
  const rawWindow = (env.WINDOW_SECONDS ?? '').trim();
  if (rawWindow) {
    windowSeconds = Number(rawWindow);
    if (!Number.isFinite(windowSeconds) || windowSeconds <= 0) {
      throw new TranscriptError('invalid_config', `WINDOW_SECONDS must be a positive number, got: ${rawWindow}`);
    }
  }

  const cacheDir = (env.CACHE_DIR ?? '').trim() || DEFAULT_CACHE_DIR;

  const maxVideoSeconds = parseMaxVideoSeconds(env);

  return { apiKey, model, maxBlockSeconds, cacheDir, windowSeconds, maxVideoSeconds };
}

// MAX_VIDEO_SECONDS is the length bound a tenant's own max_video_seconds
// overrides; the CLI and the in-process MCP path have no tenant, so it is
// their only cap.
function parseMaxVideoSeconds(env: NodeJS.ProcessEnv): number {
  let maxVideoSeconds = DEFAULT_MAX_VIDEO_SECONDS;
  const raw = (env.MAX_VIDEO_SECONDS ?? '').trim();
  if (raw) {
    maxVideoSeconds = Number(raw);
    if (!Number.isFinite(maxVideoSeconds) || maxVideoSeconds <= 0) {
      throw new TranscriptError('invalid_config', `MAX_VIDEO_SECONDS must be a positive number, got: ${raw}`);
    }
  }
  return maxVideoSeconds;
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

  let windowSeconds = DEFAULT_WINDOW_SECONDS;
  const rawWindow = (env.WINDOW_SECONDS ?? '').trim();
  if (rawWindow) {
    windowSeconds = Number(rawWindow);
    if (!Number.isFinite(windowSeconds) || windowSeconds <= 0) {
      throw new TranscriptError('invalid_config', `WINDOW_SECONDS must be a positive number, got: ${rawWindow}`);
    }
  }

  const cacheDir = (env.CACHE_DIR ?? '').trim() || DEFAULT_CACHE_DIR;

  const maxVideoSeconds = parseMaxVideoSeconds(env);

  let port = DEFAULT_PORT;
  const rawPort = (env.PORT ?? '').trim();
  if (rawPort) {
    port = Number(rawPort);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      throw new TranscriptError('invalid_config', `PORT must be an integer 1-65535, got: ${rawPort}`);
    }
  }

  const serviceToken = (env.SERVICE_TOKEN ?? '').trim() || undefined;

  const maxConcurrentJobsPerClient = parsePositiveInteger(
    env.MAX_CONCURRENT_JOBS_PER_CLIENT,
    'MAX_CONCURRENT_JOBS_PER_CLIENT',
    DEFAULT_MAX_CONCURRENT_JOBS_PER_CLIENT,
  );
  const maxJobsPerHourPerClient = parsePositiveInteger(
    env.MAX_JOBS_PER_HOUR_PER_CLIENT,
    'MAX_JOBS_PER_HOUR_PER_CLIENT',
    DEFAULT_MAX_JOBS_PER_HOUR_PER_CLIENT,
  );
  const trustedProxyIps = parseTrustedProxyIps(env.TRUSTED_PROXY_IPS ?? '');

  const tenantsFile = (env.TENANTS_FILE ?? '').trim() || undefined;
  const tenantsJson = (env.TENANTS_JSON ?? '').trim() || undefined;
  const googleCredentials = (env.GOOGLE_APPLICATION_CREDENTIALS ?? '').trim() || undefined;
  const googleCredentialsJson = (env.GOOGLE_CREDENTIALS_JSON ?? '').trim() || undefined;

  // Sign-in is off unless all four pieces are configured; a partial setup
  // fails loudly rather than silently running anonymous.
  const oidcClientId = (env.OIDC_CLIENT_ID ?? '').trim();
  const oidcClientSecret = (env.OIDC_CLIENT_SECRET ?? '').trim();
  const oidcRedirectUri = (env.OIDC_REDIRECT_URI ?? '').trim();
  const sessionSecret = (env.SESSION_SECRET ?? '').trim();
  const oidcIssuer = (env.OIDC_ISSUER ?? '').trim() || 'https://accounts.google.com';
  const anyOidc = oidcClientId !== '' || oidcClientSecret !== '' || oidcRedirectUri !== '' || sessionSecret !== '';
  const allOidc = oidcClientId !== '' && oidcClientSecret !== '' && oidcRedirectUri !== '' && sessionSecret !== '';
  if (anyOidc && !allOidc) {
    throw new TranscriptError(
      'invalid_config',
      'sign-in needs OIDC_CLIENT_ID, OIDC_CLIENT_SECRET, OIDC_REDIRECT_URI and SESSION_SECRET together',
    );
  }
  const oidc = allOidc
    ? {
        clientId: oidcClientId,
        clientSecret: oidcClientSecret,
        issuer: oidcIssuer,
        redirectUri: oidcRedirectUri,
        sessionSecret,
      }
    : undefined;

  return {
    port,
    model,
    maxBlockSeconds,
    cacheDir,
    windowSeconds,
    maxVideoSeconds,
    serviceToken,
    tenantsFile,
    tenantsJson,
    maxConcurrentJobsPerClient,
    maxJobsPerHourPerClient,
    trustedProxyIps,
    googleCredentials,
    googleCredentialsJson,
    oidc,
  };
}

// A count from the environment: unset means the default; a set-but-bad
// value fails startup like the other service variables.
function parsePositiveInteger(raw: string | undefined, name: string, fallback: number): number {
  const text = (raw ?? '').trim();
  if (text === '') return fallback;
  const value = Number(text);
  if (!Number.isInteger(value) || value <= 0) {
    throw new TranscriptError('invalid_config', `${name} must be a positive integer, got: ${text}`);
  }
  return value;
}
