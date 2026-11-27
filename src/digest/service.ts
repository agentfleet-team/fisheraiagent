import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { callerAuthorized, loadTenantsFile, parseTenantsJson, type Tenant } from '../tenants.js';
import { parseEpisodeRequest } from './contract.js';
import { errorView, type DigestErrorCode } from './errors.js';
import { DigestJobStore } from './jobs.js';
import type { DigestLlm } from './llm.js';
import type { DigestDrive } from './save.js';

export interface DigestServiceOptions {
  llmFactory: (apiKey: string) => DigestLlm;
  serviceToken?: string;
  tenantsFile?: string;
  tenantsJson?: string;
  drive?: DigestDrive;
}

const MAX_BODY_BYTES = 16 * 1024 * 1024;
const JOB_PATH = /^\/v1\/jobs\/([^/]+)$/;
const IDEMPOTENCY_KEY_FORMAT = /^[\x21-\x7e]{1,200}$/;

export function createDigestService(options: DigestServiceOptions): Server {
  const jobs = new DigestJobStore({ llmFactory: options.llmFactory, drive: options.drive });
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
  const sendError = (res: ServerResponse, status: number, code: DigestErrorCode): void => {
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
    // validate node: a bad request never reaches the model.
    const request = parseEpisodeRequest(body);
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

    // The caller's own Gemini key, else the key of the tenant whose caller
    // credential the bearer token satisfies (never a key for an unverified caller).
    // A request that names `tenant` resolves only that id — an unknown id, or
    // one the bearer does not satisfy, is a 403 that reveals no tenant data.
    const token = bearerToken(req);
    const tenants = tryTenants();
    const tenant =
      request.tenant === undefined
        ? tenants.find((t) => callerAuthorized(t, token))
        : tenants.find((t) => t.id === request.tenant && callerAuthorized(t, token));
    if (request.tenant !== undefined && tenant === undefined) {
      sendError(res, 403, 'tenant_forbidden');
      return;
    }
    const keyHeader = req.headers['x-gemini-key'];
    let apiKey = ((Array.isArray(keyHeader) ? keyHeader[0] : keyHeader) ?? '').trim();
    if (apiKey === '' && tenant?.gemini_key_env !== undefined) {
      apiKey = (process.env[tenant.gemini_key_env] ?? '').trim();
    }

    const scope = createHash('sha256').update(token ?? '').digest('hex');
    // A replay needs no key: it starts nothing.
    const outcome = jobs.submit(
      request,
      apiKey,
      tenant,
      idemKey === undefined ? undefined : { scope, key: idemKey },
    );
    if (outcome.kind === 'conflict') {
      sendError(res, 409, 'idempotency_conflict');
      return;
    }
    if (outcome.kind === 'missing_key') {
      sendError(res, 400, 'missing_key');
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
