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
  tenantsFile?: string;
  tenantsJson?: string;
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
    serviceToken,
    tenantsFile,
    tenantsJson,
    googleCredentials,
    googleCredentialsJson,
    oidc,
  };
}
