// N2's remote half (spec amendment r4, agentfleet-team/fisheraiagent#80).
// The caption read runs as its own tool (#78) behind a Cloudflare tunnel,
// and the service calls it over HTTPS: `GET <base>/v1/captions/<videoId>`
// with a bearer token, plus the Cloudflare Access service-token pair when
// the edge asks for it. A read that times out, cannot be reached, answers
// a non-200 or returns a body that is not a CaptionRead becomes
// `unavailable` with the mapped reason — the adapter never throws, never
// retries, and the job goes to Gemini exactly as if there were no reader.
// The credentials it carries live only in the request headers; nothing
// here can put them into a log line.
import {
  createCaptionReader,
  type CaptionRead,
  type CaptionReader,
  type CaptionUnavailableReason,
  type Cue,
} from './captions.js';

// One total budget for the remote read: over it the job falls back to
// Gemini instead of waiting on a slow or dead reader.
const DEFAULT_TIMEOUT_MS = 4000;

export interface RemoteCaptionReaderOptions {
  // The reader tool's base URL — config load refuses anything that is not
  // https; tests point it at a loopback fake.
  baseUrl: string;
  // The bearer credential the reader checks on every request.
  token: string;
  // The Cloudflare Access service-token pair guarding the tunnel edge,
  // sent as CF-Access-Client-Id / CF-Access-Client-Secret. Both or neither.
  accessId?: string;
  accessSecret?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

// A fetch that never produced a response: an abort means the deadline hit,
// anything else means the reader could not be reached at all.
function reasonOf(err: unknown): 'timeout' | 'unreachable' {
  if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) return 'timeout';
  return 'unreachable';
}

// Remote JSON is unknown until checked; these narrow by name/type so no
// unchecked `as` stands between the response and the code.
function field(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null && key in value ? Reflect.get(value, key) : undefined;
}

function isUnavailableReason(v: unknown): v is CaptionUnavailableReason {
  return (
    v === 'blocked' || v === 'timeout' || v === 'empty' || v === 'parse' || v === 'http' || v === 'unreachable'
  );
}

function isCue(v: unknown): v is Cue {
  const start = field(v, 'start');
  const end = field(v, 'end');
  const text = field(v, 'text');
  return (
    typeof start === 'number' &&
    Number.isFinite(start) &&
    typeof end === 'number' &&
    Number.isFinite(end) &&
    typeof text === 'string'
  );
}

// A 200 body must be a CaptionRead the service can trust, checked field by
// field; anything else is a parse failure, exactly like bad JSON.
function captionReadOf(body: unknown): CaptionRead | undefined {
  const kind = field(body, 'kind');
  if (kind === 'manual' || kind === 'auto') {
    const language = field(body, 'language');
    const durationSeconds = field(body, 'durationSeconds');
    const cues = field(body, 'cues');
    if (
      typeof language === 'string' &&
      language !== '' &&
      typeof durationSeconds === 'number' &&
      Number.isFinite(durationSeconds) &&
      Array.isArray(cues) &&
      cues.every(isCue)
    ) {
      return { kind, language, durationSeconds, cues };
    }
    return undefined;
  }
  if (kind === 'none') {
    const durationSeconds = field(body, 'durationSeconds');
    if (durationSeconds === undefined) return { kind: 'none' };
    if (typeof durationSeconds === 'number' && Number.isFinite(durationSeconds)) {
      return { kind: 'none', durationSeconds };
    }
    return undefined;
  }
  if (kind === 'unavailable') {
    const reason = field(body, 'reason');
    if (isUnavailableReason(reason)) return { kind: 'unavailable', reason };
    return undefined;
  }
  return undefined;
}

function parseRead(text: string): CaptionRead {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return { kind: 'unavailable', reason: 'parse' };
  }
  return captionReadOf(body) ?? { kind: 'unavailable', reason: 'parse' };
}

// The remote reader. Every failure returns `unavailable` with its reason —
// it never throws on the reader's behalf and never retries.
export function createRemoteCaptionReader(options: RemoteCaptionReaderOptions): CaptionReader {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const headers: Record<string, string> = {
    authorization: `Bearer ${options.token}`,
    accept: 'application/json',
  };
  if (options.accessId !== undefined) headers['cf-access-client-id'] = options.accessId;
  if (options.accessSecret !== undefined) headers['cf-access-client-secret'] = options.accessSecret;
  return async (videoId) => {
    let res: Response;
    try {
      const url = new URL(`/v1/captions/${encodeURIComponent(videoId)}`, options.baseUrl);
      res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      return { kind: 'unavailable', reason: reasonOf(err) };
    }
    if (res.status !== 200) return { kind: 'unavailable', reason: 'http' };
    let text: string;
    try {
      text = await res.text();
    } catch (err) {
      return { kind: 'unavailable', reason: reasonOf(err) };
    }
    return parseRead(text);
  };
}

// The part of ServiceConfig the N2 mode reads (kept structural so the
// resolver does not depend on config.ts).
export interface CaptionReaderConfig {
  captionsReader?: {
    url: string;
    token: string;
    accessId?: string;
    accessSecret?: string;
    timeoutMs: number;
  };
  captionsRead?: 'local';
}

export interface ResolvedCaptionReader {
  reader: CaptionReader;
  // Where the read runs, recorded on the captions_read log line.
  origin: 'remote' | 'local';
}

// The N2 mode: a configured reader URL means remote — the cloud calling
// the reader tool through its tunnel; `captionsRead: 'local'` means the
// in-process read (#76) for self-hosters on a residential-grade IP;
// anything else is off, with no YouTube call at all.
export function resolveCaptionReader(
  config: CaptionReaderConfig,
  options?: { fetchImpl?: typeof fetch },
): ResolvedCaptionReader | undefined {
  const remote = config.captionsReader;
  if (remote !== undefined) {
    return {
      origin: 'remote',
      reader: createRemoteCaptionReader({
        baseUrl: remote.url,
        token: remote.token,
        accessId: remote.accessId,
        accessSecret: remote.accessSecret,
        timeoutMs: remote.timeoutMs,
        fetchImpl: options?.fetchImpl,
      }),
    };
  }
  if (config.captionsRead === 'local') {
    return { origin: 'local', reader: createCaptionReader({ fetchImpl: options?.fetchImpl }) };
  }
  return undefined;
}
