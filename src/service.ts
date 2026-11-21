import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import type { DriveStore } from './drive.js';
import { TranscriptError } from './errors.js';
import { parseYouTubeVideoId } from './youtube-url.js';
import { JobStore, type JobRunnerDeps } from './jobs.js';
import { createTranscriptSaver, createVideoMetadata, type VideoMetadata } from './save.js';
import type { JobOrigin } from './tenants.js';

const MAX_BODY_BYTES = 16 * 1024;

export interface ServiceOptions extends JobRunnerDeps {
  serviceToken?: string;
  tenantsFile?: string;
  drive?: DriveStore;
  videoMetadata?: (videoId: string) => Promise<VideoMetadata>;
  now?: () => Date;
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
  const raw = value as Record<string, unknown>;
  const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined);
  if (raw.kind === 'discord') {
    const guild_id = str(raw.guild_id);
    const channel_id = str(raw.channel_id);
    if (guild_id && channel_id) return { kind: 'discord', guild_id, channel_id };
    throw new TranscriptError('invalid_request', 'a discord origin needs guild_id and channel_id strings');
  }
  if (raw.kind === 'web') {
    const identity = str(raw.identity);
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
  const log = options.log ?? (() => {});

  const send = (res: ServerResponse, status: number, body: unknown): void => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const sendError = (res: ServerResponse, status: number, code: string, message: string): void =>
    send(res, status, { error: { code, message } });

  const authorized = (req: IncomingMessage): boolean => {
    if (!options.serviceToken) return true;
    const header = req.headers.authorization ?? '';
    const expected = `Bearer ${options.serviceToken}`;
    if (header.length !== expected.length) return false;
    return timingSafeEqual(Buffer.from(header), Buffer.from(expected));
  };

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? 'GET';
    // Path only: query strings are never logged or inspected.
    const path = new URL(req.url ?? '/', 'http://service.local').pathname;
    log(`${method} ${path}`);

    if (method === 'GET' && path === '/healthz') {
      send(res, 200, { status: 'ok' });
      return;
    }

    if (!path.startsWith('/v1/')) {
      sendError(res, 404, 'not_found', 'unknown route');
      return;
    }
    if (!authorized(req)) {
      sendError(res, 401, 'unauthorized', 'Authorization: Bearer <SERVICE_TOKEN> is required');
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
      else sendError(res, 404, 'not_found', 'unknown job_id');
      return;
    }
    sendError(res, 404, 'not_found', 'unknown route');
  }

  async function submitJob(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let body: unknown;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      sendError(res, 400, 'invalid_request', err instanceof Error ? err.message : 'invalid request body');
      return;
    }
    const url =
      typeof body === 'object' && body !== null ? (body as Record<string, unknown>).url : undefined;
    if (typeof url !== 'string' || url.trim() === '') {
      sendError(res, 400, 'invalid_request', 'request body must be JSON with a "url" string');
      return;
    }
    const keyHeader = req.headers['x-gemini-key'];
    const apiKey = (Array.isArray(keyHeader) ? keyHeader[0] : keyHeader)?.trim() ?? '';
    if (!apiKey) {
      sendError(res, 400, 'missing_key', 'X-Gemini-Key header is required');
      return;
    }
    let videoId: string;
    try {
      videoId = parseYouTubeVideoId(url);
    } catch (err) {
      if (err instanceof TranscriptError) {
        sendError(res, 400, err.code, err.message);
        return;
      }
      throw err;
    }
    let origin: JobOrigin | undefined;
    try {
      origin = parseOrigin((body as Record<string, unknown>).origin);
    } catch (err) {
      if (err instanceof TranscriptError) {
        sendError(res, 400, err.code, err.message);
        return;
      }
      throw err;
    }
    send(res, 202, { job_id: jobs.submit(videoId, apiKey, origin) });
  }

  return createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      log(`unhandled error: ${err instanceof Error ? err.message : String(err)}`);
      if (!res.headersSent) sendError(res, 500, 'internal_error', 'unexpected server error');
      else res.end();
    });
  });
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
