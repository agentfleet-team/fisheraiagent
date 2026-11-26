// The caption-reader tool's HTTP server (agentfleet-team/fisheraiagent#78,
// spec amendment r4 on #65). It wraps the #76 reader and nothing else: no
// tenant, Gemini or Drive code. Contract:
//   GET /v1/captions/{videoId}   Authorization: Bearer <token>
//     200 CaptionRead (a YouTube-side failure is 200 with kind "unavailable")
//     400 {"error":"invalid_video_id"}   401 {"error":"unauthorized"}
//     429 {"error":"busy"}
//   GET /healthz -> 200 "ok"
// Every /v1/captions request, accepted or refused, appends one JSONL receipt.
import { createHash, timingSafeEqual } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import type { CaptionRead, CaptionReader } from './captions.js';

export interface CaptionReaderServerOptions {
  token: string;
  reader: CaptionReader;
  maxConcurrent: number;
  receiptDir: string;
}

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const CAPTIONS_PATH = /^\/v1\/captions\/([^/?#]*)$/;

const sha256 = (data: string): Buffer => createHash('sha256').update(data).digest();

// The token's identity in receipts: the first 8 hex characters of its sha256.
export const callerId = (token: string): string => sha256(token).toString('hex').slice(0, 8);

function bearer(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization;
  const match = header === undefined ? null : /^Bearer (.*)$/i.exec(header);
  return match?.[1];
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

interface Receipt {
  video_id: string;
  status: number;
  kind: string | null;
  reason: string | null;
  language: string | null;
  cue_count: number | null;
  cues_sha256: string | null;
  caller: string | null;
}

function describe(read: CaptionRead): Pick<Receipt, 'kind' | 'reason' | 'language' | 'cue_count' | 'cues_sha256'> {
  const cues = read.kind === 'manual' || read.kind === 'auto' ? read.cues : undefined;
  return {
    kind: read.kind,
    reason: read.kind === 'unavailable' ? read.reason : null,
    language: read.kind === 'manual' || read.kind === 'auto' ? read.language : null,
    cue_count: cues?.length ?? null,
    cues_sha256: cues === undefined ? null : createHash('sha256').update(JSON.stringify(cues)).digest('hex'),
  };
}

export function createCaptionReaderServer(options: CaptionReaderServerOptions): Server {
  const expected = sha256(options.token);
  mkdirSync(options.receiptDir, { recursive: true });
  let inFlight = 0;

  const writeReceipt = (receipt: Receipt, started: number): void => {
    const now = new Date();
    const line = JSON.stringify({ ts: now.toISOString(), ...receipt, ms: Date.now() - started });
    try {
      appendFileSync(join(options.receiptDir, `receipts-${now.toISOString().slice(0, 10)}.jsonl`), `${line}\n`);
    } catch {
      process.stderr.write('caption-reader: receipt write failed\n');
    }
  };

  const refuse = (res: ServerResponse, started: number, status: number, error: string, videoId: string, caller: string | null) => {
    writeReceipt(
      { video_id: videoId, status, kind: null, reason: null, language: null, cue_count: null, cues_sha256: null, caller },
      started,
    );
    send(res, status, { error });
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const started = Date.now();
    const path = (req.url ?? '').split('?')[0];
    if (req.method === 'GET' && path === '/healthz') {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('ok');
      return;
    }
    const match = req.method === 'GET' ? CAPTIONS_PATH.exec(path) : null;
    if (match === null) {
      send(res, 404, { error: 'not_found' });
      return;
    }
    let rawId = match[1];
    try {
      rawId = decodeURIComponent(rawId);
    } catch {
      // keep the raw text; it fails the id check below
    }
    const videoId = VIDEO_ID.test(rawId) ? rawId : '';

    const presented = bearer(req);
    if (presented === undefined || !timingSafeEqual(sha256(presented), expected)) {
      refuse(res, started, 401, 'unauthorized', videoId, null);
      return;
    }
    const caller = callerId(options.token);
    if (videoId === '') {
      refuse(res, started, 400, 'invalid_video_id', '', caller);
      return;
    }
    if (inFlight >= options.maxConcurrent) {
      refuse(res, started, 429, 'busy', videoId, caller);
      return;
    }
    inFlight += 1;
    try {
      const read = await options.reader(videoId);
      writeReceipt({ video_id: videoId, status: 200, ...describe(read), caller }, started);
      send(res, 200, read);
    } finally {
      inFlight -= 1;
    }
  };

  return createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) send(res, 500, { error: 'internal' });
      else res.end();
    });
  });
}
