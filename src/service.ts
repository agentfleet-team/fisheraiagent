import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import type { DriveStore } from './drive.js';
import { TranscriptError, codeOf, messageForCode, type ErrorBody, type FixedErrorCode } from './errors.js';
import { loggerFor, type LogRoute } from './log.js';
import { parseYouTubeVideoId } from './youtube-url.js';
import { JobStore, type JobRunnerDeps } from './jobs.js';
import { createTranscriptSaver, createVideoMetadata, type VideoMetadata } from './save.js';
import {
  callerAuthorized,
  loadTenantsFile,
  resolveTenant,
  type JobOrigin,
  type Tenant,
} from './tenants.js';
import { serveWebAsset } from './web-static.js';

const MAX_BODY_BYTES = 16 * 1024;

export interface ServiceOptions extends JobRunnerDeps {
  serviceToken?: string;
  tenantsFile?: string;
  drive?: DriveStore;
  videoMetadata?: (videoId: string) => Promise<VideoMetadata>;
  now?: () => Date;
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
  if (!deps.saveTranscript && options.tenantsFile) {
    deps.saveTranscript = createTranscriptSaver({
      tenantsFile: options.tenantsFile,
      drive: options.drive,
      metadata: options.videoMetadata ?? createVideoMetadata(),
      now: options.now,
      log: options.log,
    });
  }
  const jobs = new JobStore(deps);
  const log = loggerFor(options.log);

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
    const header = req.headers.authorization ?? '';
    const expected = `Bearer ${options.serviceToken}`;
    if (header.length !== expected.length) return false;
    return timingSafeEqual(Buffer.from(header), Buffer.from(expected));
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
  const verifyClaim = (req: IncomingMessage, claimed: JobOrigin): 'verified' | 'denied' | 'none' => {
    if (!options.tenantsFile) return 'none';
    let tenants: Tenant[];
    try {
      tenants = loadTenantsFile(options.tenantsFile);
    } catch {
      return 'none';
    }
    const tenant = resolveTenant(tenants, claimed);
    if (!tenant) return 'none';
    return callerAuthorized(tenant, bearerToken(req)) ? 'verified' : 'denied';
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

    if (!path.startsWith('/v1/')) {
      if (await serveWebAsset(method, path, res)) return;
      sendError(res, 404, 'not_found');
      return;
    }
    if (!authorized(req)) {
      sendError(res, 401, 'unauthorized');
      return;
    }

    if (method === 'POST' && path === '/v1/jobs') {
      await submitJob(req, res);
      return;
    }
    const jobMatch = /^\/v1\/jobs\/([^/]+)$/.exec(path);
    if (method === 'GET' && jobMatch) {
      const view = jobs.get(decodeURIComponent(jobMatch[1]));
      if (view) send(res, 200, view);
      else sendError(res, 404, 'not_found');
      return;
    }
    sendError(res, 404, 'not_found');
  }

  async function submitJob(req: IncomingMessage, res: ServerResponse): Promise<void> {
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
    // Web callers are anonymous until sign-in (#6): their origin shows the
    // transcript only and saves nothing. Discord claims are verified here;
    // only a verified claim reaches the job's save hook.
    let origin: JobOrigin | undefined;
    let saveDenied = false;
    if (claimed?.kind === 'discord') {
      const verdict = verifyClaim(req, claimed);
      if (verdict === 'verified') origin = claimed;
      else if (verdict === 'denied') saveDenied = true;
    }
    send(res, 202, { job_id: jobs.submit(videoId, apiKey, origin, saveDenied) });
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
