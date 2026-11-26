// Error codes of the digest tool. Like the transcript tool, an HTTP error
// body or a failed job carries a fixed code and the fixed message the table
// below holds for it, never caught or upstream text.

export type DigestErrorCode =
  | 'invalid_request'
  | 'missing_key'
  | 'key_rejected'
  | 'quota_exceeded'
  | 'upstream_timeout'
  | 'upstream_rejected'
  | 'model_not_found'
  | 'script_check_failed'
  | 'idempotency_conflict'
  | 'save_failed'
  | 'unauthorized'
  | 'not_found'
  | 'internal_error';

const MESSAGES: Readonly<Record<DigestErrorCode, string>> = Object.freeze({
  invalid_request: 'request body is not a valid EpisodeRequest',
  missing_key: 'a Gemini API key is required',
  key_rejected: 'the Gemini API key was rejected',
  quota_exceeded: 'the Gemini API key is out of quota',
  upstream_timeout: 'the upstream request timed out',
  upstream_rejected: 'the upstream service rejected the request',
  model_not_found: 'the configured model was not found',
  script_check_failed: 'the model output failed the script check after one repair call',
  idempotency_conflict: 'this Idempotency-Key was already used with a different request',
  save_failed: 'the script could not be saved to the configured destination',
  unauthorized: 'Authorization: Bearer <SERVICE_TOKEN> is required',
  not_found: 'unknown route or job_id',
  internal_error: 'unexpected server error',
});

export function digestMessage(code: DigestErrorCode): string {
  return MESSAGES[code];
}

export interface DigestErrorView {
  code: DigestErrorCode;
  message: string;
}

export function errorView(code: DigestErrorCode): DigestErrorView {
  return { code, message: digestMessage(code) };
}

export class DigestError extends Error {
  readonly code: DigestErrorCode;

  constructor(code: DigestErrorCode) {
    super(code);
    this.name = 'DigestError';
    this.code = code;
  }
}

export function digestCodeOf(err: unknown): DigestErrorCode {
  return err instanceof DigestError ? err.code : 'internal_error';
}
