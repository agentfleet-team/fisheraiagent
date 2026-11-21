import type { Transcript } from '../transcript.js';

export class ApiError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
  }
}

// The bot's only view of the transcript service: submit a URL, wait for the
// transcript or a coded failure. The guild's Gemini key goes out once, in the
// submit request header, and is never part of an error or a log line.
export interface TranscriptApi {
  transcribe(youtubeUrl: string, apiKey: string): Promise<Transcript>;
}

export interface ApiClientOptions {
  baseUrl: string;
  serviceToken?: string;
  pollIntervalMs?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

interface RemoteError {
  code: string;
  message: string;
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
  'bad_model_output',
  'invalid_config',
  'invalid_request',
  'unauthorized',
  'not_found',
  'internal_error',
]);

function remoteCode(value: unknown, fallback: string): string {
  return typeof value === 'string' && REMOTE_ERROR_CODES.has(value) ? value : fallback;
}

async function readError(res: Response, fallbackCode: string): Promise<RemoteError> {
  const body = (await res.json().catch(() => null)) as {
    error?: { code?: unknown; message?: unknown };
  } | null;
  const code = remoteCode(body?.error?.code, fallbackCode);
  // The service's message travels only with a code the contract recognizes.
  const message =
    code === body?.error?.code && typeof body?.error?.message === 'string'
      ? body.error.message
      : `service returned HTTP ${res.status}`;
  return { code, message };
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
    async transcribe(youtubeUrl, apiKey) {
      let submitRes: Response;
      try {
        submitRes = await doFetch(`${base}/v1/jobs`, {
          method: 'POST',
          headers: { ...headers(), 'x-gemini-key': apiKey },
          body: JSON.stringify({ url: youtubeUrl }),
        });
      } catch (err) {
        throw new ApiError(
          'api_unreachable',
          `cannot reach transcript service: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      if (submitRes.status !== 202) {
        const err = await readError(submitRes, 'internal_error');
        throw new ApiError(err.code, err.message);
      }
      const { job_id: jobId } = (await submitRes.json()) as { job_id: string };

      const deadline = Date.now() + timeoutMs;
      for (;;) {
        let pollRes: Response;
        try {
          pollRes = await doFetch(`${base}/v1/jobs/${encodeURIComponent(jobId)}`, {
            headers: headers(),
          });
        } catch (err) {
          throw new ApiError(
            'api_unreachable',
            `lost contact with transcript service: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        if (pollRes.status === 404) {
          throw new ApiError('job_lost', 'the service restarted and lost the job');
        }
        if (!pollRes.ok) {
          const err = await readError(pollRes, 'internal_error');
          throw new ApiError(err.code, err.message);
        }
        const job = (await pollRes.json()) as {
          status: string;
          result?: Transcript;
          error?: { code?: string; message?: string };
        };
        if (job.status === 'done' && job.result) return job.result;
        if (job.status === 'failed') {
          const code = remoteCode(job.error?.code, 'internal_error');
          const message =
            code === job.error?.code && typeof job.error?.message === 'string'
              ? job.error.message
              : 'transcription job failed';
          throw new ApiError(code, message);
        }
        if (Date.now() > deadline) {
          throw new ApiError('job_timeout', 'timed out waiting for the transcript');
        }
        await sleep(pollIntervalMs);
      }
    },
  };
}
