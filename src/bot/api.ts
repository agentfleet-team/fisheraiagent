import { parseDriveLink, type DriveLink } from '../drive.js';
import type { JobOrigin } from '../tenants.js';
import type { Transcript } from '../transcript.js';
import { webdavPath, type WebdavPath } from '../webdav.js';

export class ApiError extends Error {
  readonly code: string;

  // Carries a code only; the message is the code, never remote or caught text.
  constructor(code: string) {
    super(code);
    this.name = 'ApiError';
    this.code = code;
  }
}

// The link a Discord reply may carry. `url` is branded DriveLink and `path`
// is branded WebdavPath: raw wire text becomes one only through a parser
// that renders a canonical value, so no string — caught text, a remote
// field, a literal with a newline — can reach a reply through it.
export type SavedLink =
  | { type: 'google-drive'; name: string; url: DriveLink }
  | { type: 'webdav'; name: string; path: WebdavPath };

export interface TranscriptOutcome {
  transcript: Transcript;
  saved?: SavedLink;
  saveErrorCode?: string;
}

// The bot's only view of the transcript service: submit a URL, wait for the
// transcript or a coded failure. The guild's Gemini key goes out once, in the
// submit request header, and is never part of an error or a log line.
export interface TranscriptApi {
  transcribe(youtubeUrl: string, apiKey: string, origin?: JobOrigin): Promise<TranscriptOutcome>;
}

export interface ApiClientOptions {
  baseUrl: string;
  serviceToken?: string;
  pollIntervalMs?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

// The service contract (openapi.yaml) defines this finite set of error
// codes. Anything else a remote server returns is untrusted text: it folds
// into the fallback code before it can reach a log line or a Discord reply.
const REMOTE_ERROR_CODES = new Set([
  'invalid_url',
  'video_unavailable',
  'missing_key',
  'key_rejected',
  'quota_exceeded',
  'upstream_timeout',
  'upstream_rejected',
  'upstream_media_error',
  'model_not_found',
  'bad_model_output',
  'invalid_config',
  'invalid_request',
  'unauthorized',
  'not_found',
  'internal_error',
  'rate_limited',
  'video_too_long',
]);

// save_error codes the service contract defines; anything else folds to
// save_failed before it can reach a log line or a Discord reply.
const SAVE_ERROR_CODES = new Set(['save_failed', 'save_unauthorized', 'invalid_config', 'no_tenant']);

function remoteCode(value: unknown, fallback: string): string {
  return typeof value === 'string' && REMOTE_ERROR_CODES.has(value) ? value : fallback;
}

// Remote JSON is unknown until checked. Each accessor narrows the fields it
// reads so no unchecked `as` stands between the wire and the code.
type RemoteKey =
  | 'status'
  | 'result'
  | 'error'
  | 'code'
  | 'job_id'
  | 'video_id'
  | 'source_url'
  | 'language'
  | 'blocks'
  | 'saved'
  | 'save_error'
  | 'type'
  | 'url'
  | 'name'
  | 'folder'
  | 'path';

function prop(value: unknown, key: RemoteKey): unknown {
  return typeof value === 'object' && value !== null && key in value
    ? Reflect.get(value, key)
    : undefined;
}

function isTranscript(value: unknown): value is Transcript {
  return (
    typeof prop(value, 'video_id') === 'string' &&
    typeof prop(value, 'source_url') === 'string' &&
    typeof prop(value, 'language') === 'string' &&
    Array.isArray(prop(value, 'blocks'))
  );
}

// A saved link is echoed into a Discord message, so it is trusted only
// after the strictest check the boundary can make: a Drive url must parse
// to a branded canonical link (another host, a newline or any trailing text
// drops the whole link), and a WebDAV saved value must carry the
// destination/file structure — folder plus file name — that webdavPath
// re-renders into a branded canonical path. A ready-made `path` string is
// never trusted, and the name must be bounded.
function parseSavedLink(value: unknown): SavedLink | undefined {
  const name = prop(value, 'name');
  if (typeof name !== 'string' || name.length > 300) return undefined;
  if (prop(value, 'type') === 'google-drive') {
    const url = parseDriveLink(prop(value, 'url'));
    return url === undefined ? undefined : { type: 'google-drive', name, url };
  }
  if (prop(value, 'type') === 'webdav') {
    const path = webdavPath(prop(value, 'folder'), name);
    return path === undefined ? undefined : { type: 'webdav', name, path };
  }
  return undefined;
}

async function readErrorCode(res: Response, fallbackCode: string): Promise<string> {
  const body: unknown = await res.json().catch(() => null);
  return remoteCode(prop(prop(body, 'error'), 'code'), fallbackCode);
}

export function createApiClient(options: ApiClientOptions): TranscriptApi {
  const base = options.baseUrl.replace(/\/+$/, '');
  const pollIntervalMs = options.pollIntervalMs ?? 2000;
  const timeoutMs = options.timeoutMs ?? 30 * 60 * 1000;
  const doFetch = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));

  const headers = (): Record<string, string> => ({
    'content-type': 'application/json',
    ...(options.serviceToken ? { authorization: `Bearer ${options.serviceToken}` } : {}),
  });

  return {
    async transcribe(youtubeUrl, apiKey, origin) {
      let submitRes: Response;
      try {
        submitRes = await doFetch(`${base}/v1/jobs`, {
          method: 'POST',
          headers: { ...headers(), 'x-gemini-key': apiKey },
          body: JSON.stringify({ url: youtubeUrl, ...(origin ? { origin } : {}) }),
        });
      } catch {
        throw new ApiError('api_unreachable');
      }
      if (submitRes.status !== 202) {
        throw new ApiError(await readErrorCode(submitRes, 'internal_error'));
      }
      const submitBody: unknown = await submitRes.json();
      const jobIdValue = prop(submitBody, 'job_id');
      const jobId = typeof jobIdValue === 'string' ? jobIdValue : '';

      const deadline = Date.now() + timeoutMs;
      for (;;) {
        let pollRes: Response;
        try {
          pollRes = await doFetch(`${base}/v1/jobs/${encodeURIComponent(jobId)}`, {
            headers: headers(),
          });
        } catch {
          throw new ApiError('api_unreachable');
        }
        if (pollRes.status === 404) throw new ApiError('job_lost');
        if (!pollRes.ok) {
          throw new ApiError(await readErrorCode(pollRes, 'internal_error'));
        }
        const job: unknown = await pollRes.json();
        const status = prop(job, 'status');
        const result = prop(job, 'result');
        if (status === 'done' && isTranscript(result)) {
          const outcome: TranscriptOutcome = { transcript: result };
          const saved = parseSavedLink(prop(job, 'saved'));
          if (saved) outcome.saved = saved;
          const saveCode = prop(prop(job, 'save_error'), 'code');
          if (typeof saveCode === 'string') {
            outcome.saveErrorCode = SAVE_ERROR_CODES.has(saveCode) ? saveCode : 'save_failed';
          }
          return outcome;
        }
        if (status === 'failed') {
          throw new ApiError(remoteCode(prop(prop(job, 'error'), 'code'), 'internal_error'));
        }
        if (Date.now() > deadline) throw new ApiError('job_timeout');
        await sleep(pollIntervalMs);
      }
    },
  };
}
