// Error codes of the voice tool. An HTTP error body or a failed job carries a
// fixed code and the fixed message below, never caught or upstream text. A
// failed render job also names the section that failed.

export type VoiceErrorCode =
  | 'invalid_request'
  | 'render_failed'
  | 'duration_out_of_band'
  | 'idempotency_conflict'
  | 'save_failed'
  | 'unauthorized'
  | 'not_found'
  | 'internal_error';

const MESSAGES: Readonly<Record<VoiceErrorCode, string>> = Object.freeze({
  invalid_request: 'request body is not a valid VoiceRequest',
  render_failed: 'a section could not be rendered after one retry',
  duration_out_of_band: 'the joined audio duration is outside expect_seconds',
  idempotency_conflict: 'this Idempotency-Key was already used with a different request',
  save_failed: 'the episode could not be saved to the configured destination',
  unauthorized: 'Authorization: Bearer <SERVICE_TOKEN> is required',
  not_found: 'unknown route or job_id',
  internal_error: 'unexpected server error',
});

export interface VoiceErrorView {
  code: VoiceErrorCode;
  message: string;
  section_id?: string;
}

export function errorView(code: VoiceErrorCode, sectionId?: string): VoiceErrorView {
  const view: VoiceErrorView = { code, message: MESSAGES[code] };
  if (sectionId !== undefined) view.section_id = sectionId;
  return view;
}

export class VoiceError extends Error {
  readonly code: VoiceErrorCode;
  readonly sectionId?: string;

  constructor(code: VoiceErrorCode, sectionId?: string) {
    super(code);
    this.name = 'VoiceError';
    this.code = code;
    this.sectionId = sectionId;
  }
}

export function voiceErrorView(err: unknown): VoiceErrorView {
  return err instanceof VoiceError ? errorView(err.code, err.sectionId) : errorView('internal_error');
}
