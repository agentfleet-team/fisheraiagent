const GITHUB_API = "https://api.github.com";
const JWT_BACK_S = 60;
const JWT_LIFETIME_S = 9 * 60;
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

export type AppPermission = "contents" | "issues";

/** One narrow credential scope: a repository name and a single write permission. */
export interface TokenScope {
  repo: string;
  permission: AppPermission;
}

/** What a GitHub caller needs: the current token, and a fresh one after a 401. */
export interface TokenProvider {
  get(): Promise<string>;
  renew(): Promise<string>;
}

export interface AppSecrets {
  GITHUB_APP_ID?: string;
  GITHUB_APP_INSTALLATION_ID?: string;
  GITHUB_APP_PRIVATE_KEY?: string;
}

export const MISSING_APP_SECRETS = "missing_secret:github_app";
export const INVALID_TOKEN_RESPONSE = "GitHub App token mint returned an invalid response";

export function hasAppSecrets(env: AppSecrets | undefined): boolean {
  return [env?.GITHUB_APP_ID, env?.GITHUB_APP_INSTALLATION_ID, env?.GITHUB_APP_PRIVATE_KEY].every(
    (v) => typeof v === "string" && v.trim() !== "",
  );
}

function b64url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlJson(value: unknown): string {
  return b64url(new TextEncoder().encode(JSON.stringify(value)));
}

async function importKey(pem: string): Promise<CryptoKey> {
  const body = pem
    .replace(/-----(?:BEGIN|END) PRIVATE KEY-----/g, "")
    .replace(/\s+/g, "");
  const binary = atob(body);
  const der = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) der[i] = binary.charCodeAt(i);
  return crypto.subtle.importKey(
    "pkcs8",
    der,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

export async function signAppJwt(
  appId: string,
  privateKeyPem: string,
  nowMs: number,
): Promise<string> {
  const nowS = Math.floor(nowMs / 1000);
  const signingInput = `${b64urlJson({ alg: "RS256", typ: "JWT" })}.${b64urlJson({
    iat: nowS - JWT_BACK_S,
    exp: nowS + JWT_LIFETIME_S,
    iss: appId,
  })}`;
  let key: CryptoKey;
  try {
    key = await importKey(privateKeyPem);
  } catch {
    throw new Error("GitHub App private key is not a PKCS#8 PEM");
  }
  const sig = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${b64url(new Uint8Array(sig))}`;
}

export interface AppTokensOptions {
  now?: () => number;
  fetchFn?: typeof fetch;
  /** Status-only log line sink; never receives key, JWT or token. */
  log?: (line: string) => void;
}

/**
 * Mints installation tokens narrowed to one repository and one permission,
 * and caches each (repo, permission) token until 5 minutes before it expires.
 */
export function appTokens(env: AppSecrets, options: AppTokensOptions = {}) {
  const now = options.now ?? Date.now;
  const doFetch = options.fetchFn ?? ((input, init) => fetch(input, init));
  const cache = new Map<string, { token: string; expiresMs: number }>();

  async function mint(scope: TokenScope): Promise<{ token: string; expiresMs: number }> {
    const jwt = await signAppJwt(env.GITHUB_APP_ID!, env.GITHUB_APP_PRIVATE_KEY!, now());
    const res = await doFetch(
      `${GITHUB_API}/app/installations/${encodeURIComponent(env.GITHUB_APP_INSTALLATION_ID!)}/access_tokens`,
      {
        method: "POST",
        headers: {
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "podcast-night",
          Authorization: `Bearer ${jwt}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          repositories: [scope.repo],
          permissions: { [scope.permission]: "write" },
        }),
      },
    );
    if (res.status !== 201) {
      throw new Error(`GitHub App token mint failed with status ${res.status}`);
    }
    let data: { token?: unknown; expires_at?: unknown };
    try {
      data = (await res.json()) as { token?: unknown; expires_at?: unknown };
    } catch {
      throw new Error(INVALID_TOKEN_RESPONSE);
    }
    const expiresMs = typeof data.expires_at === "string" ? Date.parse(data.expires_at) : NaN;
    if (typeof data.token !== "string" || data.token === "" || Number.isNaN(expiresMs)) {
      throw new Error(INVALID_TOKEN_RESPONSE);
    }
    options.log?.(`token minted repo=${scope.repo} perm=${scope.permission}`);
    return { token: data.token, expiresMs };
  }

  async function fresh(scope: TokenScope): Promise<string> {
    const entry = await mint(scope);
    cache.set(`${scope.repo}\u0000${scope.permission}`, entry);
    return entry.token;
  }

  return {
    scope(scope: TokenScope): TokenProvider {
      const id = `${scope.repo}\u0000${scope.permission}`;
      return {
        async get() {
          const hit = cache.get(id);
          if (hit !== undefined && now() < hit.expiresMs - REFRESH_MARGIN_MS) return hit.token;
          return fresh(scope);
        },
        renew: () => fresh(scope),
      };
    },
  };
}

/** Sends a request with the provider's token; on one 401 it mints again and retries once. */
export async function fetchWithToken(
  provider: TokenProvider,
  send: (token: string) => Promise<Response>,
): Promise<Response> {
  const res = await send(await provider.get());
  if (res.status !== 401) return res;
  return send(await provider.renew());
}
