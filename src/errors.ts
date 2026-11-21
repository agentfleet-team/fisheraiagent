import { safeText, type SafeText } from './safe-text.js';

export type ErrorCode =
  | 'invalid_url'
  | 'video_unavailable'
  | 'missing_key'
  | 'key_rejected'
  | 'quota_exceeded'
  | 'upstream_timeout'
  | 'bad_model_output'
  | 'invalid_config';

export class TranscriptError extends Error {
  readonly code: ErrorCode;
  readonly httpStatus?: number;

  constructor(code: ErrorCode, message: string, options?: { cause?: unknown; httpStatus?: number }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'TranscriptError';
    this.code = code;
    this.httpStatus = options?.httpStatus;
  }
}

// The only text a boundary (HTTP body, CLI output) may show for a failure:
// looked up by code, never taken from the caught error. Every entry is a
// SafeText literal, so an error body can carry nothing else.
const ERROR_MESSAGES: Record<ErrorCode | 'invalid_request' | 'unauthorized' | 'not_found' | 'internal_error', SafeText> = {
  invalid_url: safeText('not a usable YouTube URL or video id'),
  video_unavailable: safeText('the video is unavailable or cannot be transcribed'),
  missing_key: safeText('a Gemini API key is required'),
  key_rejected: safeText('the Gemini API key was rejected'),
  quota_exceeded: safeText('the Gemini API key is out of quota'),
  upstream_timeout: safeText('the upstream request timed out'),
  bad_model_output: safeText('the model returned output in an unexpected format'),
  invalid_config: safeText('the service configuration is invalid'),
  invalid_request: safeText('request body must be JSON with a "url" string'),
  unauthorized: safeText('Authorization: Bearer <SERVICE_TOKEN> is required'),
  not_found: safeText('unknown route or job_id'),
  internal_error: safeText('unexpected server error'),
};

export type FixedErrorCode = keyof typeof ERROR_MESSAGES;

// The shape of every HTTP error body: a fixed code and its branded message.
export interface ErrorBody {
  error: { code: FixedErrorCode; message: SafeText };
}

export function messageForCode(code: FixedErrorCode): SafeText {
  return ERROR_MESSAGES[code];
}

export function codeOf(err: unknown): FixedErrorCode {
  return err instanceof TranscriptError ? err.code : 'internal_error';
}
