import { safeText, type MessageCode, type SafeText } from './safe-text.js';

export type ErrorCode =
  | 'invalid_url'
  | 'video_unavailable'
  | 'missing_key'
  | 'key_rejected'
  | 'quota_exceeded'
  | 'upstream_timeout'
  | 'upstream_rejected'
  | 'model_not_found'
  | 'bad_model_output'
  | 'invalid_config'
  | 'invalid_request';

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

// Every code an HTTP error body may carry: the non-bot entries of the fixed
// messages table. The body text a boundary may show comes only from that
// table, looked up by code — never from the caught error.
export type FixedErrorCode = Exclude<MessageCode, `bot.${string}`>;

// The shape of every HTTP error body: a fixed code and its branded message.
export interface ErrorBody {
  error: { code: FixedErrorCode; message: SafeText };
}

export function messageForCode(code: FixedErrorCode): SafeText {
  return safeText(code);
}

export function codeOf(err: unknown): FixedErrorCode {
  return err instanceof TranscriptError ? err.code : 'internal_error';
}
