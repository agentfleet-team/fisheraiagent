import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { callerAuthorized, loadTenantsFile, parseTenantsJson, type Tenant } from '../tenants.js';
import { parseVoiceRequest } from './contract.js';
import { errorView, type VoiceErrorCode } from './errors.js';
import type { VoiceEngine } from './engine.js';
import { VoiceJobStore } from './jobs.js';
import type { VoiceDrive } from './save.js';

export interface VoiceServiceOptions {
  engine: VoiceEngine;
  chunkTimeoutMs?: number;
  serviceToken?: string;
  tenantsFile?: string;
  tenantsJson?: string;
  drive?: VoiceDrive;
}

const MAX_BODY_BYTES = 1024 * 1024;
const JOB_PATH = /^\/v1\/jobs\/([^/]+)$/;
const AUDIO_PATH = /^\/v1\/jobs\/([^/]+)\/audio$/;
const IDEMPOTENCY_KEY_FORMAT = /^[\x21-\x7e]{1,200}$/;

export function createVoiceService(options: VoiceServiceOptions): Server {
  const jobs = new VoiceJobStore({ engine: options.engine, drive: options.drive, chunkTimeoutMs: options.chunkTimeoutMs });
  const hasTenants = options.tenantsFile !== undefined || options.tenantsJson !== undefined;

  // Re-read on every submit, like the transcript tool: adding a tenant is
  // configuration. An unreadable document means no tenant.
  const tryTenants = (): Tenant[] => {
    if (!hasTenants) return [];
    try {
      return options.tenantsFile !== undefined
        ? loadTenantsFile(options.tenantsFile)
        : parseTenantsJson(options.tenantsJson ?? '', 'TENANTS_JSON');
    } catch {
      return [];
    }
  };

  const send = (res: ServerResponse, status: number, body: unknown): void => {
    const text = JSON.stringify(body);
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(text);
  };
  const sendError = (res: ServerResponse, status: number, code: VoiceErrorCode): void => {
    send(res, status, { error: errorView(code) });
  };

  const authorized = (req: IncomingMessage): boolean => {
    if (!options.serviceToken) return true;
    const header = Buffer.from(req.headers.authorization ?? '', 'utf8');
    const expected = Buffer.from(`Bearer ${options.serviceToken}`, 'utf8');
    return header.length === expected.length && timingSafeEqual(header, expected);
  };

  const bearerToken = (req: IncomingMessage): string | undefined => {
    const header = req.headers.authorization ?? '';
    return header.startsWith('Bearer ') ? header.slice(7).trim() || undefined : undefined;
  };

  async function submit(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let body: unknown;
    try {
      body = await readJsonBody(req);
    } catch {
      sendError(res, 400, 'invalid_request');
      return;
    }
    // validate node: a bad request never reaches the TTS engine.
    const request = parseVoiceRequest(body);
    if (request === undefined) {
      sendError(res, 400, 'invalid_request');
      return;
    }

    const rawIdem = req.headers['idempotency-key'];
    const idemKey = (Array.isArray(rawIdem) ? rawIdem[0] : rawIdem)?.trim();
    if (idemKey !== undefined && !IDEMPOTENCY_KEY_FORMAT.test(idemKey)) {
      sendError(res, 400, 'invalid_request');
      return;
    }

    // The tenant whose caller credential the bearer token satisfies holds the
    // save destination (never a destination for an unverified caller).
    const token = bearerToken(req);
    const tenant = tryTenants().find((t) => callerAuthorized(t, token));

    const scope = createHash('sha256').update(token ?? '').digest('hex');
    const outcome = jobs.submit(request, tenant, idemKey === undefined ? undefined : { scope, key: idemKey });
    if (outcome.kind === 'conflict') {
      sendError(res, 409, 'idempotency_conflict');
      return;
    }
    send(res, 202, { job_id: outcome.jobId });
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? 'GET';
    const path = new URL(req.url ?? '/', 'http://service.local').pathname;

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
      await submit(req, res);
      return;
    }
    const audioMatch = AUDIO_PATH.exec(path);
    if (method === 'GET' && audioMatch) {
      const audio = jobs.audio(decodeURIComponent(audioMatch[1]));
      if (audio === undefined) {
        sendError(res, 404, 'not_found');
        return;
      }
      res.writeHead(200, { 'content-type': 'audio/mpeg', 'content-length': audio.length });
      res.end(audio);
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

  return createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) sendError(res, 500, 'internal_error');
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
