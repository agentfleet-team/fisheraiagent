import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { createAuth, createOidcClient, type Auth, type OidcClientConfig } from './auth.js';
import { cachedVideoCoverage, TRANSCRIPT_FORMAT_VERSION } from './cache.js';
import {
  clientIp,
  ClientRateLimiter,
  DEFAULT_MAX_CONCURRENT_JOBS_PER_CLIENT,
  DEFAULT_MAX_JOBS_PER_HOUR_PER_CLIENT,
  DEFAULT_TRUSTED_PROXY_IPS,
  proxyMatcher,
} from './client-limit.js';
import { DEFAULT_COMMIT, DEFAULT_VERSION, DEFAULT_WINDOW_SECONDS } from './config.js';
import type { DriveStore } from './drive.js';
import { TranscriptError, codeOf, messageForCode, type ErrorBody, type FixedErrorCode } from './errors.js';
import { loggerFor, type LogRoute } from './log.js';
import { parseYouTubeVideoId } from './youtube-url.js';
import { JobStore, type JobRunnerDeps, type SaveBlock } from './jobs.js';
import { createTranscriptSaver, createVideoMetadata, type VideoMetadata } from './save.js';
import {
  callerAuthorized,
  loadTenantsFile,
  parseTenantsJson,
  resolveTenant,
  TenantRateLimiter,
  type JobOrigin,
  type Tenant,
} from './tenants.js';
import { serveWebAsset } from './web-static.js';

const MAX_BODY_BYTES = 16 * 1024;
const JOB_PATH = /^\/v1\/jobs\/([^/]+)$/;

// Sign-in configuration: everything a Google (or generic OIDC) sign-in
// needs. Sign-in exists only when this is set; without it the web page and
// jobs stay anonymous.
export interface OidcServiceConfig extends OidcClientConfig {
  sessionSecret: string;
}

export interface ServiceOptions extends JobRunnerDeps {
  // Build identity reported by GET /v1/config and the page footer; baked in
  // at image build time. Unset means a dev build.
  version?: string;
  commit?: string;
  serviceToken?: string;
  tenantsFile?: string;
  // The tenants document inline (from a secrets-manager env var) instead
  // of a file path. tenantsFile wins when both are set.
  tenantsJson?: string;
  drive?: DriveStore;
  webdavFetch?: typeof fetch;
  // Per-client limits on job creation for the public surface: at most
  // maxConcurrentJobsPerClient in-flight jobs and maxJobsPerHourPerClient
  // accepted submissions per client, identified by CF-Connecting-IP when
  // the socket peer is a trusted proxy (the Cloudflare Tunnel) and by the
  // socket address otherwise. They apply only when no SERVICE_TOKEN is
  // configured — a bearer-authenticated caller is trusted infrastructure
  // (the Discord bot, an MCP client) and is not limited.
  maxConcurrentJobsPerClient?: number;
  maxJobsPerHourPerClient?: number;
  // Peers whose requests may supply the client IP via CF-Connecting-IP:
  // exact IPv4/IPv6 addresses or IPv4 CIDRs. The default trusts loopback —
  // the documented deployment runs cloudflared in the same task or host.
  trustedProxies?: string[];
  videoMetadata?: (videoId: string) => Promise<VideoMetadata>;
  now?: () => Date;
  // Built sign-in handler (tests inject one); when absent but `oidc` is
  // set, the real OIDC client is built from it.
  auth?: Auth;
  oidc?: OidcServiceConfig;
}

// Remote JSON is unknown until checked; this narrows fields by name so no
// unchecked `as` stands between the request body and the code.
function field(value: object, key: string): unknown {
  return key in value ? Reflect.get(value, key) : undefined;
}

// The submit body's optional "origin": where the job came from, used to
// resolve the tenant whose destination the transcript is saved to.
//   {"kind": "discord", "guild_id": "...", "channel_id": "..."}
//   {"kind": "web", "identity": "..."}
function parseOrigin(value: unknown): JobOrigin | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object') {
    throw new TranscriptError('invalid_request', 'origin must be an object');
  }
  const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined);
  const kind = field(value, 'kind');
  if (kind === 'discord') {
    const guild_id = str(field(value, 'guild_id'));
    const channel_id = str(field(value, 'channel_id'));
    if (guild_id && channel_id) return { kind: 'discord', guild_id, channel_id };
    throw new TranscriptError('invalid_request', 'a discord origin needs guild_id and channel_id strings');
  }
  if (kind === 'web') {
    const identity = str(field(value, 'identity'));
    if (identity) return { kind: 'web', identity };
    throw new TranscriptError('invalid_request', 'a web origin needs an identity string');
  }
  throw new TranscriptError('invalid_request', 'origin.kind must be "discord" or "web"');
}

export function createService(options: ServiceOptions): Server {
  const deps: JobRunnerDeps = { ...options };
  // The tenants document is re-read on every job submit, from the file or
  // the inline JSON — adding a tenant stays configuration, not code.
  const hasTenants = options.tenantsFile !== undefined || options.tenantsJson !== undefined;
  const loadTenants = (): Tenant[] =>
    options.tenantsFile !== undefined
      ? loadTenantsFile(options.tenantsFile)
      : parseTenantsJson(options.tenantsJson ?? '', 'TENANTS_JSON');
  if (!deps.saveTranscript && hasTenants) {
    deps.saveTranscript = createTranscriptSaver({
      loadTenants,
      drive: options.drive,
      webdavFetch: options.webdavFetch,
      metadata: options.videoMetadata ?? createVideoMetadata(),
      now: options.now,
      log: options.log,
    });
  }
  deps.knownDurationSeconds ??= (videoId) =>
    cachedVideoCoverage(
      options.cacheDir,
      videoId,
      options.model,
      options.maxBlockSeconds,
      options.windowSeconds ?? DEFAULT_WINDOW_SECONDS,
      TRANSCRIPT_FORMAT_VERSION,
    );
  // The per-client limiter guards the anonymous surface only: with a
  // SERVICE_TOKEN configured, every caller that reaches submitJob already
  // authenticated as trusted infrastructure. A malformed trusted-proxy
  // entry fails startup rather than silently widening who may speak for
  // the client IP.
  const proxyTrust = proxyMatcher(options.trustedProxies ?? DEFAULT_TRUSTED_PROXY_IPS);
  const maxConcurrentJobs = options.maxConcurrentJobsPerClient ?? DEFAULT_MAX_CONCURRENT_JOBS_PER_CLIENT;
  const maxJobsPerHour = options.maxJobsPerHourPerClient ?? DEFAULT_MAX_JOBS_PER_HOUR_PER_CLIENT;
  if (!Number.isInteger(maxConcurrentJobs) || maxConcurrentJobs <= 0) {
    throw new TranscriptError('invalid_config', 'maxConcurrentJobsPerClient must be a positive integer');
  }
  if (!Number.isInteger(maxJobsPerHour) || maxJobsPerHour <= 0) {
    throw new TranscriptError('invalid_config', 'maxJobsPerHourPerClient must be a positive integer');
  }
  const clientLimiter =
    options.serviceToken === undefined
      ? new ClientRateLimiter({ maxConcurrentJobs, maxJobsPerHour })
      : undefined;
  // job_id -> the client its in-flight slot is booked to; released when
  // the store reports the job finished.
  const pendingClients = new Map<string, string>();
  const callerOnFinished = options.onJobFinished;
  deps.onJobFinished = (jobId: string) => {
    const client = pendingClients.get(jobId);
    if (client !== undefined) {
      pendingClients.delete(jobId);
      clientLimiter?.release(client);
    }
    callerOnFinished?.(jobId);
  };
  const jobs = new JobStore(deps);
  const log = loggerFor(options.log);
  const limiter = new TenantRateLimiter();
  const auth =
    options.auth ??
    (options.oidc
      ? createAuth({ client: createOidcClient(options.oidc), sessionSecret: options.oidc.sessionSecret })
      : undefined);

  // The verified sign-in session's email from the request's cookies, or
  // undefined when sign-in is off, the cookie is absent, or the signature
  // or expiry check fails (a tampered cookie is anonymous, not signed in).
  const sessionEmail = (req: IncomingMessage): string | undefined => {
    if (!auth) return undefined;
    const raw = req.headers.cookie;
    const header = Array.isArray(raw) ? raw.join('; ') : raw;
    return auth.sessionEmail(header);
  };

  // The tenants document as configured, or undefined when tenants are not
  // configured or the document cannot be read — a broken tenant source
  // resolves nothing rather than guessing.
  const tryTenants = (): Tenant[] | undefined => {
    if (!hasTenants) return undefined;
    try {
      return loadTenants();
    } catch {
      return undefined;
    }
  };

  const send = (res: ServerResponse, status: number, body: unknown): void => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  // Error bodies carry only a code and its fixed SafeText message.
  const sendError = (res: ServerResponse, status: number, code: FixedErrorCode): void => {
    const body: ErrorBody = { error: { code, message: messageForCode(code) } };
    send(res, status, body);
  };

  const authorized = (req: IncomingMessage): boolean => {
    if (!options.serviceToken) return true;
    const header = Buffer.from(req.headers.authorization ?? '', 'utf8');
    const expected = Buffer.from(`Bearer ${options.serviceToken}`, 'utf8');
    if (header.length !== expected.length) return false;
    return timingSafeEqual(header, expected);
  };

  const bearerToken = (req: IncomingMessage): string | undefined => {
    const raw = req.headers.authorization;
    const header = (Array.isArray(raw) ? raw[0] : raw) ?? '';
    return header.startsWith('Bearer ') ? header.slice(7).trim() || undefined : undefined;
  };

  // An origin in the request body is a claim, not proof. It is trusted only
  // when the bearer token the caller presented is the credential the
  // resolved tenant entry names (the token's SHA-256, or an env reference);
  // anything else is untrusted caller-controlled text. A claim that names a
  // real tenant but fails the credential check is denied — the job still
  // runs and reports the fixed save_unauthorized error — while a claim that
  // matches no tenant is dropped silently, exactly like no origin at all.
  const verifyClaim = (
    req: IncomingMessage,
    claimed: JobOrigin,
  ): { verdict: 'verified' | 'denied' | 'none'; tenant?: Tenant } => {
    const tenants = tryTenants();
    if (!tenants) return { verdict: 'none' };
    const tenant = resolveTenant(tenants, claimed);
    if (!tenant) return { verdict: 'none' };
    return callerAuthorized(tenant, bearerToken(req))
      ? { verdict: 'verified', tenant }
      : { verdict: 'denied', tenant };
  };

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? 'GET';
    // Path only: query strings are never logged or inspected.
    const path = new URL(req.url ?? '/', 'http://service.local').pathname;
    log('http_request', { route: routeTemplate(method, path) });

    if (method === 'GET' && path === '/healthz') {
      send(res, 200, { status: 'ok' });
      return;
    }

    // Sign-in endpoints exist only when OIDC is configured; without it the
    // paths fall through to the static page's 404 like any unknown name.
    if (auth && path.startsWith('/auth/')) {
      await handleAuth(req, res, path, auth);
      return;
    }

    if (!path.startsWith('/v1/')) {
      if (await serveWebAsset(method, path, res)) return;
      sendError(res, 404, 'not_found');
      return;
    }
    if (!authorized(req)) {
      sendError(res, 401, 'unauthorized');
      return;
    }

    // Non-secret configuration the web page reads once: the model the
    // service runs, so the page's save-time key check can probe that exact
    // model against Gemini, and the build identity the footer shows. No key
    // or caller data is involved.
    if (method === 'GET' && path === '/v1/config') {
      send(res, 200, {
        model: options.model,
        version: options.version ?? DEFAULT_VERSION,
        commit: options.commit ?? DEFAULT_COMMIT,
      });
      return;
    }
    if (method === 'POST' && path === '/v1/jobs') {
      await submitJob(req, res);
      return;
    }
    const jobMatch = JOB_PATH.exec(path);
    if (method === 'GET' && jobMatch) {
      const view = jobs.get(decodeURIComponent(jobMatch[1]));
      if (view) send(res, 200, view);
      else sendError(res, 404, 'not_found');
      return;
    }
    sendError(res, 404, 'not_found');
  }

  // The sign-in flow: /auth/login redirects to the provider with a fresh
  // state + PKCE challenge and sets a short-lived signed af_login cookie
  // that binds the pending login to this browser. /auth/callback checks
  // the returned state and that cookie against the pending login and the
  // code against the provider, then sets the signed session cookie and
  // clears af_login. A callback without a known state, without the
  // matching af_login cookie, or with a rejected code gets the fixed 400.
  // /auth/me reports the session to the page; /auth/logout expires it.
  async function handleAuth(
    req: IncomingMessage,
    res: ServerResponse,
    path: string,
    session: Auth,
  ): Promise<void> {
    const method = req.method ?? 'GET';
    if (method === 'GET' && path === '/auth/login') {
      const { url, cookie } = await session.loginUrl();
      res.writeHead(302, { location: url, 'set-cookie': cookie });
      res.end();
      return;
    }
    if (method === 'GET' && path === '/auth/callback') {
      const query = new URL(req.url ?? '/', 'http://service.local').searchParams;
      const rawCookie = req.headers.cookie;
      const cookieHeader = Array.isArray(rawCookie) ? rawCookie.join('; ') : rawCookie;
      const email = await session.completeLogin(
        {
          code: query.get('code') ?? undefined,
          state: query.get('state') ?? undefined,
        },
        cookieHeader,
      );
      if (email === undefined) {
        sendError(res, 400, 'invalid_request');
        return;
      }
      res.writeHead(302, {
        location: '/',
        'set-cookie': [session.sessionCookie(email), session.loginClearCookie()],
      });
      res.end();
      return;
    }
    if (path === '/auth/logout' && (method === 'GET' || method === 'POST')) {
      res.writeHead(302, { location: '/', 'set-cookie': session.clearCookie() });
      res.end();
      return;
    }
    if (method === 'GET' && path === '/auth/me') {
      const email = sessionEmail(req);
      const body: { enabled: boolean; signed_in: boolean; email?: string; tenant?: string } = {
        enabled: true,
        signed_in: email !== undefined,
      };
      if (email !== undefined) {
        body.email = email;
        const tenants = tryTenants();
        const tenant = tenants
          ? resolveTenant(tenants, { kind: 'web', identity: email })
          : undefined;
        if (tenant) body.tenant = tenant.id;
      }
      send(res, 200, body);
      return;
    }
    sendError(res, 404, 'not_found');
  }

  async function submitJob(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // The per-client check books its slot in one synchronous step before
    // the body is even read: a flood is answered 429 without spending
    // parse, key or tenant-file work, and requests racing the check
    // cannot overshoot a cap — each already holds its slot while it
    // waits. The client is the CF-Connecting-IP value only when the
    // socket peer is a trusted proxy (the tunnel); any other peer is
    // keyed on its address. A booking whose request is rejected below is
    // given back, so a rejection consumes no allowance; only a submitted
    // job keeps it.
    const ticket =
      clientLimiter === undefined
        ? undefined
        : clientLimiter.tryAdmit(
            clientIp(req.socket.remoteAddress, req.headers['cf-connecting-ip'], proxyTrust),
          );
    if (clientLimiter !== undefined && ticket === undefined) {
      sendError(res, 429, 'rate_limited');
      return;
    }
    let submitted = false;
    try {
      let body: unknown;
      try {
        body = await readJsonBody(req);
      } catch {
        sendError(res, 400, 'invalid_request');
        return;
      }
      const url = typeof body === 'object' && body !== null ? field(body, 'url') : undefined;
      if (typeof url !== 'string' || url.trim() === '') {
        sendError(res, 400, 'invalid_request');
        return;
      }
      const keyHeader = req.headers['x-gemini-key'];
      const apiKey = (Array.isArray(keyHeader) ? keyHeader[0] : keyHeader)?.trim() ?? '';
      if (!apiKey) {
        sendError(res, 400, 'missing_key');
        return;
      }
      let videoId: string;
      try {
        videoId = parseYouTubeVideoId(url);
      } catch (err) {
        if (err instanceof TranscriptError) {
          sendError(res, 400, codeOf(err));
          return;
        }
        throw err;
      }
      let claimed: JobOrigin | undefined;
      try {
        claimed = parseOrigin(typeof body === 'object' && body !== null ? field(body, 'origin') : undefined);
      } catch (err) {
        if (err instanceof TranscriptError) {
          sendError(res, 400, codeOf(err));
          return;
        }
        throw err;
      }
      // Who is this caller? A verified sign-in session is the strongest
      // identity: its email resolves to a tenant through web_emails and
      // becomes the job's authenticated origin — a request field, header or
      // claimed origin that names another tenant is ignored entirely, so a
      // signed-in caller can never land a job in a tenant that is not its
      // own. A session email no tenant allowlists still gets its transcript
      // plus the fixed no_tenant message. Without a session, anonymous web
      // requests keep the old behavior (transcript only) and only a discord
      // claim is checked, against the resolved tenant's caller credential.
      let origin: JobOrigin | undefined;
      let saveBlocked: SaveBlock | undefined;
      let tenant: Tenant | undefined;
      const email = sessionEmail(req);
      if (email !== undefined) {
        const tenants = tryTenants();
        tenant = tenants ? resolveTenant(tenants, { kind: 'web', identity: email }) : undefined;
        if (tenant) origin = { kind: 'web', identity: email };
        else saveBlocked = 'no_tenant';
      } else if (claimed?.kind === 'discord') {
        const { verdict, tenant: resolved } = verifyClaim(req, claimed);
        if (verdict === 'verified') {
          origin = claimed;
          tenant = resolved;
        } else if (verdict === 'denied') {
          saveBlocked = 'unauthorized';
        }
      }
      // Per-tenant limits apply only to the authenticated caller they came
      // with: an unauthenticated claim never spends a tenant's allowance.
      const perHour = tenant?.limits?.jobs_per_hour;
      if (tenant && perHour !== undefined && !limiter.allow(tenant.id, perHour)) {
        sendError(res, 429, 'rate_limited');
        return;
      }
      const jobId = jobs.submit(videoId, apiKey, origin, saveBlocked, tenant?.limits);
      // The booking is now the job's: the hourly hit stays, and the
      // in-flight half returns via deps.onJobFinished when the store
      // settles the job.
      if (ticket !== undefined) pendingClients.set(jobId, ticket.client);
      submitted = true;
      send(res, 202, { job_id: jobId });
    } finally {
      if (!submitted && ticket !== undefined) clientLimiter?.cancel(ticket);
    }
  }

  return createServer((req, res) => {
    handle(req, res).catch(() => {
      log('http_unhandled_error');
      if (!res.headersSent) sendError(res, 500, 'internal_error');
      else res.end();
    });
  });
}

function routeTemplate(method: string, path: string): LogRoute {
  if (method === 'GET' && path === '/healthz') return 'GET /healthz';
  if (method === 'GET' && path === '/v1/config') return 'GET /v1/config';
  if (method === 'POST' && path === '/v1/jobs') return 'POST /v1/jobs';
  if (method === 'GET' && /^\/v1\/jobs\/[^/]+$/.test(path)) return 'GET /v1/jobs/:id';
  return 'other';
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('request body is not valid JSON'));
      }
    });
    req.on('error', reject);
  });
}
