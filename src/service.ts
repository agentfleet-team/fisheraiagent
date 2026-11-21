import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { TranscriptError } from './errors.js';
import { parseYouTubeVideoId } from './youtube-url.js';
import { JobStore, type JobRunnerDeps } from './jobs.js';

const MAX_BODY_BYTES = 16 * 1024;
const JOB_PATH = /^\/v1\/jobs\/([^/]+)$/;

export interface ServiceOptions extends JobRunnerDeps {
  serviceToken?: string;
}

export function createService(options: ServiceOptions): Server {
  const jobs = new JobStore(options);
  const log = options.log ?? (() => {});

  const send = (res: ServerResponse, status: number, body: unknown): void => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const sendError = (res: ServerResponse, status: number, code: string, message: string): void =>
    send(res, status, { error: { code, message } });

  const authorized = (req: IncomingMessage): boolean => {
    if (!options.serviceToken) return true;
    const header = Buffer.from(req.headers.authorization ?? '', 'utf8');
    const expected = Buffer.from(`Bearer ${options.serviceToken}`, 'utf8');
    if (header.length !== expected.length) return false;
    return timingSafeEqual(header, expected);
  };

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? 'GET';
    // Path only: query strings are never logged or inspected.
    const path = new URL(req.url ?? '/', 'http://service.local').pathname;
    // Path segments are caller input and can carry secrets: log route templates.
    const route =
      path === '/healthz' || path === '/v1/jobs'
        ? path
        : JOB_PATH.test(path)
          ? '/v1/jobs/{job_id}'
          : '(unmatched)';
    log(`${method} ${route}`);

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
    const jobMatch = JOB_PATH.exec(path);
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
        // The parser message echoes the raw input, which can embed caller secrets.
        sendError(res, 400, err.code, 'url is not a YouTube URL or video id');
        return;
      }
      throw err;
    }
    send(res, 202, { job_id: jobs.submit(videoId, apiKey) });
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
