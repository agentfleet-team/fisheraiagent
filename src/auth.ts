// Web sign-in: OpenID Connect authorization code flow with PKCE, then a
// signed HttpOnly session cookie. Sign-in exists only when configured
// (OIDC_CLIENT_ID, OIDC_CLIENT_SECRET, OIDC_REDIRECT_URI, SESSION_SECRET);
// an instance without it keeps the anonymous behavior. The sign-in only
// proves an email address; which tenant that email may act for is decided
// by the tenant config's web_emails allowlist.
import {
  createHash,
  createHmac,
  createPublicKey,
  createVerify,
  randomBytes,
  timingSafeEqual,
  type JsonWebKey,
  type KeyObject,
} from 'node:crypto';
import { TranscriptError } from './errors.js';

// The two halves of sign-in. OidcClient talks to the provider (discovery,
// code exchange, id_token verification); Auth runs the state/PKCE pending
// store and the signed session cookie.
export interface OidcClientConfig {
  clientId: string;
  clientSecret: string;
  issuer: string;
  redirectUri: string;
  fetchImpl?: typeof fetch;
}

export interface OidcClient {
  authorizationUrl(params: { state: string; nonce: string; codeChallenge: string }): Promise<string>;
  // Returns the verified, lowercased email claim, or undefined when the
  // code or the id_token does not check out.
  redeemCode(params: { code: string; codeVerifier: string; nonce: string }): Promise<string | undefined>;
}

// Remote JSON is unknown until checked; this narrows fields by name so no
// unchecked `as` stands between the provider's documents and the code.
function field(value: object, key: string): unknown {
  return key in value ? Reflect.get(value, key) : undefined;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value !== '';
}

function b64urlJson(part: string): unknown {
  try {
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
  } catch {
    return undefined;
  }
}

interface OidcEndpoints {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  jwksUri: string;
}

export function createOidcClient(config: OidcClientConfig): OidcClient {
  const fetchImpl = config.fetchImpl ?? fetch;
  const issuer = config.issuer.replace(/\/+$/, '');
  const issuerScheme = (() => {
    try {
      return `${new URL(issuer).protocol}//`;
    } catch {
      throw new TranscriptError('invalid_config', 'OIDC_ISSUER is not a valid URL');
    }
  })();
  let endpointsPromise: Promise<OidcEndpoints> | undefined;
  let jwksPromise: Promise<Map<string, JsonWebKey>> | undefined;

  const endpoints = (): Promise<OidcEndpoints> => {
    endpointsPromise ??= (async () => {
      let parsed: unknown;
      try {
        const res = await fetchImpl(`${issuer}/.well-known/openid-configuration`);
        if (!res.ok) throw new Error('discovery failed');
        parsed = await res.json();
      } catch (err) {
        throw new TranscriptError(
          'invalid_config',
          `cannot read the sign-in provider's configuration: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      const doc = typeof parsed === 'object' && parsed !== null ? parsed : {};
      const authorizationEndpoint = field(doc, 'authorization_endpoint');
      const tokenEndpoint = field(doc, 'token_endpoint');
      const jwksUri = field(doc, 'jwks_uri');
      // Endpoints must be absolute http(s) URLs and match the issuer's
      // scheme — a public issuer is https; an http issuer is a local test
      // or dev provider.
      const scheme = issuerScheme;
      if (
        !isNonEmptyString(authorizationEndpoint) ||
        !isNonEmptyString(tokenEndpoint) ||
        !isNonEmptyString(jwksUri) ||
        !authorizationEndpoint.startsWith(scheme) ||
        !tokenEndpoint.startsWith(scheme) ||
        !jwksUri.startsWith(scheme)
      ) {
        throw new TranscriptError(
          'invalid_config',
          "the sign-in provider's configuration lacks usable endpoints for the issuer's scheme",
        );
      }
      return { authorizationEndpoint, tokenEndpoint, jwksUri };
    })();
    return endpointsPromise;
  };

  const jwks = (): Promise<Map<string, JsonWebKey>> => {
    const promise =
      jwksPromise ??
      (async () => {
      const { jwksUri } = await endpoints();
      let parsed: unknown;
      try {
        const res = await fetchImpl(jwksUri);
        if (!res.ok) throw new Error('jwks fetch failed');
        parsed = await res.json();
      } catch (err) {
        throw new TranscriptError(
          'invalid_config',
          `cannot read the sign-in provider's keys: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      const doc = typeof parsed === 'object' && parsed !== null ? parsed : {};
      const keys = field(doc, 'keys');
      const map = new Map<string, JsonWebKey>();
      if (Array.isArray(keys)) {
        for (const entry of keys) {
          if (typeof entry !== 'object' || entry === null) continue;
          const kty = field(entry, 'kty');
          const kid = field(entry, 'kid');
          const n = field(entry, 'n');
          const e = field(entry, 'e');
          if (kty !== 'RSA' || !isNonEmptyString(n) || !isNonEmptyString(e)) continue;
          const jwk: JsonWebKey = { kty: 'RSA', n, e };
          if (isNonEmptyString(kid)) jwk.kid = kid;
          map.set(isNonEmptyString(kid) ? kid : '', jwk);
        }
      }
      return map;
      })();
    jwksPromise = promise;
    // A bad key set is retried on the next login, not cached forever.
    promise.catch(() => {
      if (jwksPromise === promise) jwksPromise = undefined;
    });
    return promise;
  };

  const verifyIdToken = async (idToken: string, expectedNonce: string): Promise<string | undefined> => {
    const parts = idToken.split('.');
    if (parts.length !== 3) return undefined;
    const header = b64urlJson(parts[0] ?? '');
    const payload = b64urlJson(parts[1] ?? '');
    if (typeof header !== 'object' || header === null || typeof payload !== 'object' || payload === null) {
      return undefined;
    }
    if (field(header, 'alg') !== 'RS256') return undefined;
    const keys = await jwks();
    const kid = field(header, 'kid');
    const jwk = isNonEmptyString(kid) ? keys.get(kid) : keys.size === 1 ? [...keys.values()][0] : undefined;
    if (!jwk) return undefined;
    let key: KeyObject;
    try {
      key = createPublicKey({ key: jwk, format: 'jwk' });
    } catch {
      return undefined;
    }
    const verifier = createVerify('RSA-SHA256');
    verifier.update(`${parts[0]}.${parts[1]}`);
    if (!verifier.verify(key, Buffer.from(parts[2] ?? '', 'base64url'))) return undefined;

    // Google's id_token reports iss without the scheme on some flows; the
    // issuer is otherwise compared exactly.
    const iss = field(payload, 'iss');
    const googleIssuer = issuer === 'https://accounts.google.com' && iss === 'accounts.google.com';
    if (iss !== issuer && !googleIssuer) return undefined;
    const aud = field(payload, 'aud');
    const audience = Array.isArray(aud) ? aud : [aud];
    if (!audience.includes(config.clientId)) return undefined;
    const exp = field(payload, 'exp');
    if (typeof exp !== 'number' || exp * 1000 <= Date.now()) return undefined;
    if (field(payload, 'nonce') !== expectedNonce) return undefined;
    if (field(payload, 'email_verified') === false) return undefined;
    const email = field(payload, 'email');
    if (!isNonEmptyString(email) || !email.includes('@')) return undefined;
    return email.toLowerCase();
  };

  return {
    async authorizationUrl({ state, nonce, codeChallenge }) {
      const { authorizationEndpoint } = await endpoints();
      const url = new URL(authorizationEndpoint);
      url.searchParams.set('client_id', config.clientId);
      url.searchParams.set('redirect_uri', config.redirectUri);
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('scope', 'openid email');
      url.searchParams.set('state', state);
      url.searchParams.set('nonce', nonce);
      url.searchParams.set('code_challenge', codeChallenge);
      url.searchParams.set('code_challenge_method', 'S256');
      return url.toString();
    },

    async redeemCode({ code, codeVerifier, nonce }) {
      const { tokenEndpoint } = await endpoints();
      let parsed: unknown;
      try {
        const res = await fetchImpl(tokenEndpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'authorization_code',
            code,
            redirect_uri: config.redirectUri,
            client_id: config.clientId,
            client_secret: config.clientSecret,
            code_verifier: codeVerifier,
          }).toString(),
        });
        if (!res.ok) return undefined;
        parsed = await res.json();
      } catch {
        return undefined;
      }
      const doc = typeof parsed === 'object' && parsed !== null ? parsed : {};
      const idToken = field(doc, 'id_token');
      if (!isNonEmptyString(idToken)) return undefined;
      return verifyIdToken(idToken, nonce);
    },
  };
}

const COOKIE_NAME = 'af_session';
const DEFAULT_SESSION_TTL_SECONDS = 12 * 60 * 60;
const PENDING_TTL_MS = 10 * 60 * 1000;

interface PendingLogin {
  verifier: string;
  nonce: string;
  expiresAt: number;
}

export interface AuthDeps {
  client: OidcClient;
  sessionSecret: string;
  sessionTtlSeconds?: number;
  now?: () => number;
}

export interface Auth {
  cookieName: string;
  loginUrl(): Promise<string>;
  // The email of the completed sign-in, or undefined when the callback is
  // missing a known state or the provider rejects the code.
  completeLogin(query: { code?: string; state?: string }): Promise<string | undefined>;
  sessionCookie(email: string): string;
  clearCookie(): string;
  // The verified session email from a Cookie header value, or undefined
  // when no cookie, a bad signature or an expired session.
  sessionEmail(cookieHeader: string | undefined): string | undefined;
}

export function createAuth(deps: AuthDeps): Auth {
  const now = deps.now ?? (() => Date.now());
  const ttlSeconds = deps.sessionTtlSeconds ?? DEFAULT_SESSION_TTL_SECONDS;
  const pending = new Map<string, PendingLogin>();

  const sign = (payload: string): string =>
    createHmac('sha256', deps.sessionSecret).update(payload).digest('base64url');

  const prune = (): void => {
    for (const [state, p] of pending) {
      if (p.expiresAt <= now()) pending.delete(state);
    }
  };

  return {
    cookieName: COOKIE_NAME,

    async loginUrl() {
      prune();
      const state = randomBytes(24).toString('base64url');
      const verifier = randomBytes(48).toString('base64url');
      const nonce = randomBytes(16).toString('base64url');
      pending.set(state, { verifier, nonce, expiresAt: now() + PENDING_TTL_MS });
      const codeChallenge = createHash('sha256').update(verifier).digest('base64url');
      return deps.client.authorizationUrl({ state, nonce, codeChallenge });
    },

    async completeLogin(query) {
      prune();
      if (!query.code || !query.state) return undefined;
      const entry = pending.get(query.state);
      pending.delete(query.state);
      if (!entry || entry.expiresAt <= now() || entry.verifier === '') return undefined;
      return deps.client.redeemCode({ code: query.code, codeVerifier: entry.verifier, nonce: entry.nonce });
    },

    sessionCookie(email) {
      const payload = Buffer.from(
        JSON.stringify({ email, exp: Math.floor(now() / 1000) + ttlSeconds }),
      ).toString('base64url');
      return `${COOKIE_NAME}=${payload}.${sign(payload)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${ttlSeconds}`;
    },

    clearCookie() {
      return `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
    },

    sessionEmail(cookieHeader) {
      if (!cookieHeader) return undefined;
      let value: string | undefined;
      for (const part of cookieHeader.split(';')) {
        const trimmed = part.trim();
        if (trimmed.startsWith(`${COOKIE_NAME}=`)) {
          value = trimmed.slice(COOKIE_NAME.length + 1);
          break;
        }
      }
      if (!value) return undefined;
      const dot = value.lastIndexOf('.');
      if (dot <= 0) return undefined;
      const payload = value.slice(0, dot);
      const given = value.slice(dot + 1);
      const expected = sign(payload);
      if (
        expected.length !== given.length ||
        !timingSafeEqual(Buffer.from(expected), Buffer.from(given))
      ) {
        return undefined;
      }
      const parsed = b64urlJson(payload);
      if (typeof parsed !== 'object' || parsed === null) return undefined;
      const email = field(parsed, 'email');
      const exp = field(parsed, 'exp');
      if (!isNonEmptyString(email) || typeof exp !== 'number' || exp * 1000 <= now()) {
        return undefined;
      }
      return email;
    },
  };
}
