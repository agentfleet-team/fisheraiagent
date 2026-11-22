import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { TranscriptError, codeOf, messageForCode, type ErrorBody, type FixedErrorCode } from './errors.js';
import { loggerFor, type LogRoute } from './log.js';
import { parseYouTubeVideoId } from './youtube-url.js';
import { JobStore, type JobRunnerDeps } from './jobs.js';

const MAX_BODY_BYTES = 16 * 1024;
const JOB_PATH = /^\/v1\/jobs\/([^/]+)$/;

export interface ServiceOptions extends JobRunnerDeps {
  serviceToken?: string;
}

export function createService(options: ServiceOptions): Server {
  const jobs = new JobStore(options);
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
    const header = Buffer.from(req.headers.authorization ?? '', 'utf8');
    const expected = Buffer.from(`Bearer ${options.serviceToken}`, 'utf8');
    if (header.length !== expected.length) return false;
    return timingSafeEqual(header, expected);
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
    const jobMatch = JOB_PATH.exec(path);
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
    const url =
      typeof body === 'object' && body !== null && 'url' in body ? body.url : undefined;
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
    send(res, 202, { job_id: jobs.submit(videoId, apiKey) });
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
