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
// looked up by code, never taken from the caught error.
const ERROR_MESSAGES: Record<ErrorCode | 'invalid_request' | 'unauthorized' | 'not_found' | 'internal_error', string> = {
  invalid_url: 'not a usable YouTube URL or video id',
  video_unavailable: 'the video is unavailable or cannot be transcribed',
  missing_key: 'a Gemini API key is required',
  key_rejected: 'the Gemini API key was rejected',
  quota_exceeded: 'the Gemini API key is out of quota',
  upstream_timeout: 'the upstream request timed out',
  bad_model_output: 'the model returned output in an unexpected format',
  invalid_config: 'the service configuration is invalid',
  invalid_request: 'request body must be JSON with a "url" string',
  unauthorized: 'Authorization: Bearer <SERVICE_TOKEN> is required',
  not_found: 'unknown route or job_id',
  internal_error: 'unexpected server error',
};

export type FixedErrorCode = keyof typeof ERROR_MESSAGES;

export function messageForCode(code: FixedErrorCode): string {
  return ERROR_MESSAGES[code];
}

export function codeOf(err: unknown): FixedErrorCode {
  return err instanceof TranscriptError ? err.code : 'internal_error';
}
