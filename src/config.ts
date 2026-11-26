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
  version: string;
  commit: string;
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
  // N2's remote caption read (spec amendment r4): set only when the
  // environment supplies a complete remote setup — CAPTIONS_READER_URL
  // (https only) plus CAPTIONS_READER_TOKEN, the Cloudflare Access
  // service-token pair together or not at all.
  captionsReader?: {
    url: string;
    token: string;
    accessId?: string;
    accessSecret?: string;
    timeoutMs: number;
  };
  // 'local' when CAPTIONS_READ asks for the in-process caption read.
  captionsRead?: 'local';
  googleCredentials?: string;
  googleCredentialsJson?: string;
  googleOauthJson?: string;
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
// One total budget for a remote caption read before the job falls back to
// Gemini.
export const DEFAULT_CAPTIONS_READER_TIMEOUT_MS = 4000;
// Build identity: the Docker build bakes APP_VERSION/APP_COMMIT in as build
// args; a local run without them reports the dev defaults.
export const DEFAULT_VERSION = '0.0.0-dev';
export const DEFAULT_COMMIT = 'unknown';

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

  const version = (env.APP_VERSION ?? '').trim() || DEFAULT_VERSION;
  const commit = (env.APP_COMMIT ?? '').trim() || DEFAULT_COMMIT;

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
  const googleOauthJson = (env.GOOGLE_OAUTH_JSON ?? '').trim() || undefined;

  const captionsReader = parseCaptionsReader(env);
  const captionsRead = parseCaptionsRead(env);

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
    version,
    commit,
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
    googleOauthJson,
    captionsReader,
    captionsRead,
    oidc,
  };
}

// CAPTIONS_READER_URL picks the remote caption reader (the tool behind
// its tunnel). It is https-only and needs the bearer token the reader
// checks; the optional Cloudflare Access service-token pair must be
// complete or absent. Credentials without the URL fail startup like every
// other partial configuration.
function parseCaptionsReader(env: NodeJS.ProcessEnv): ServiceConfig['captionsReader'] {
  const url = (env.CAPTIONS_READER_URL ?? '').trim();
  const token = (env.CAPTIONS_READER_TOKEN ?? '').trim() || undefined;
  const accessId = (env.CAPTIONS_READER_ACCESS_ID ?? '').trim() || undefined;
  const accessSecret = (env.CAPTIONS_READER_ACCESS_SECRET ?? '').trim() || undefined;
  const timeoutMs = parsePositiveInteger(
    env.CAPTIONS_READER_TIMEOUT_MS,
    'CAPTIONS_READER_TIMEOUT_MS',
    DEFAULT_CAPTIONS_READER_TIMEOUT_MS,
  );
  if (url === '') {
    if (token !== undefined || accessId !== undefined || accessSecret !== undefined) {
      throw new TranscriptError('invalid_config', 'CAPTIONS_READER credentials need CAPTIONS_READER_URL');
    }
    return undefined;
  }
  let https: boolean;
  try {
    https = new URL(url).protocol === 'https:';
  } catch {
    https = false;
  }
  if (!https) {
    throw new TranscriptError('invalid_config', 'CAPTIONS_READER_URL must be a valid https URL');
  }
  if (token === undefined) {
    throw new TranscriptError('invalid_config', 'CAPTIONS_READER_URL needs CAPTIONS_READER_TOKEN');
  }
  if ((accessId === undefined) !== (accessSecret === undefined)) {
    throw new TranscriptError(
      'invalid_config',
      'CAPTIONS_READER_ACCESS_ID and CAPTIONS_READER_ACCESS_SECRET must be set together',
    );
  }
  return { url, token, accessId, accessSecret, timeoutMs };
}

// CAPTIONS_READ names the non-remote mode: exactly "local" keeps the
// in-process read for self-hosters; any other value fails loudly rather
// than silently turning the read off.
function parseCaptionsRead(env: NodeJS.ProcessEnv): 'local' | undefined {
  const raw = (env.CAPTIONS_READ ?? '').trim();
  if (raw === '') return undefined;
  if (raw !== 'local') {
    throw new TranscriptError('invalid_config', `CAPTIONS_READ must be "local" or unset, got: ${raw}`);
  }
  return 'local';
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
