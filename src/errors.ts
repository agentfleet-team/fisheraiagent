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
