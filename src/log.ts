// The only way code in src/ writes a log line. `event` is one of a fixed set
// of names and `fields` is a closed allowlist of ids, codes, counts and route
// templates. Nothing here accepts an Error or free text, so a boundary cannot
// put caught or request-derived text into a log line. Id fields take branded
// types from ids.ts: they exist only after a parse function has checked the
// id format, and the emit loop re-checks that format, so caught text cannot
// reach a log line through an id field even behind a cast.

import {
  ID_FORMATS,
  type ChannelId,
  type DriveFileId,
  type DriveFolderId,
  type GuildId,
  type JobId,
  type TenantId,
  type VideoId,
} from './ids.js';
import type { GeminiFallbackReason } from './captions.js';
import type { ModelOutputErrorReason } from './model-output.js';
import type { TranscriptSource } from './transcript.js';

export type LogEvent =
  | 'http_request'
  | 'http_unhandled_error'
  | 'service_listening'
  | 'cache_hit'
  | 'captions_read'
  | 'source_chosen'
  | 'gemini_call'
  | 'gemini_extra_call'
  | 'model_output_error'
  | 'block_over_limit'
  | 'clip_blocks_dropped'
  | 'key_set'
  | 'key_removed'
  | 'channel_enabled'
  | 'channel_disabled'
  | 'job_submitted'
  | 'job_done'
  | 'job_failed'
  | 'file_saved'
  | 'file_save_failed'
  | 'delivery_sent'
  | 'delivery_failed'
  | 'discord_ready'
  | 'commands_registered'
  | 'command_registration_failed'
  | 'message_handler_failed'
  | 'command_handler_failed'
  | 'startup_failed';

export type LogRoute = 'GET /healthz' | 'GET /v1/config' | 'POST /v1/jobs' | 'GET /v1/jobs/:id' | 'other';

export type LogCode =
  | 'invalid_url'
  | 'video_unavailable'
  | 'missing_key'
  | 'key_rejected'
  | 'quota_exceeded'
  | 'upstream_timeout'
  | 'upstream_rejected'
  | 'upstream_media_error'
  | 'model_not_found'
  | 'bad_model_output'
  | 'invalid_config'
  | 'invalid_request'
  | 'unauthorized'
  | 'not_found'
  | 'api_unreachable'
  | 'job_lost'
  | 'job_timeout'
  | 'save_failed'
  | 'save_unauthorized'
  | 'no_tenant'
  | 'rate_limited'
  | 'video_too_long'
  | 'delivery_failed'
  | 'delivery_refused'
  | 'internal_error'
  | 'usage';

// Why a Gemini call beyond a clip's first request was spent — the only
// detail the gemini_extra_call event carries besides the window it
// belongs to.
export type ExtraCallReason =
  | 'strict_retry'
  | 'empty_full_window'
  | 'subclip'
  | 'tail_reask'
  | 'media_retry'
  | 'continuation';

export interface LogFields {
  guild?: GuildId;
  channel?: ChannelId;
  tenant?: TenantId;
  video?: VideoId;
  job?: JobId;
  folder?: DriveFolderId;
  file?: DriveFileId;
  dest?: 'google-drive' | 'webdav';
  route?: LogRoute;
  code?: LogCode;
  // Where a caption read ran (captions_read) — the remote reader tool or
  // the in-process reader.
  origin?: 'remote' | 'local';
  // What a caption read found (captions_read) — manual, auto, none or
  // unavailable.
  kind?: 'manual' | 'auto' | 'none' | 'unavailable';
  // The transcript source a job's read resolved to (source_chosen).
  source?: TranscriptSource;
  // The HTTP status of a failed destination call, and Google's reason
  // identifier for it (never free text).
  httpStatus?: number;
  apiReason?: string;
  port?: number;
  count?: number;
  durationMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  reason?: ModelOutputErrorReason | ExtraCallReason | GeminiFallbackReason;
  windowStart?: number;
  longestBlockSeconds?: number;
}

export type LogSink = (line: string) => void;
export type Logger = (event: LogEvent, fields?: LogFields) => void;

const FIELD_ORDER: readonly (keyof LogFields)[] = [
  'guild',
  'channel',
  'tenant',
  'video',
  'job',
  'folder',
  'file',
  'dest',
  'route',
  'code',
  'origin',
  'kind',
  'source',
  'httpStatus',
  'apiReason',
  'port',
  'count',
  'longestBlockSeconds',
  'durationMs',
  'inputTokens',
  'outputTokens',
  'totalTokens',
  'reason',
  'windowStart',
];

const ID_FIELD_FORMATS: Partial<Record<keyof LogFields, RegExp>> = {
  ...ID_FORMATS,
  dest: /^(google-drive|webdav)$/,
  httpStatus: /^[1-5]\d\d$/,
  apiReason: /^[A-Za-z_]{1,64}$/,
  kind: /^(manual|auto|none|unavailable)$/,
  origin: /^(remote|local)$/,
  source: /^(captions:manual|captions:auto|gemini)$/,
  reason:
    /^(invalid_timestamp|block_too_long|end_before_start|out_of_order|no_blocks|strict_retry|empty_full_window|subclip|tail_reask|media_retry|continuation|blocked|timeout|empty|parse|http|unreachable|auto|none)$/,
};

export const consoleSink: LogSink = (line) => console.log(line);
export const stderrSink: LogSink = (line) => console.error(line);

export function createLogger(sink: LogSink): Logger {
  return (event, fields = {}) => {
    const parts: string[] = [event];
    for (const key of FIELD_ORDER) {
      const value = fields[key];
      if (value === undefined) continue;
      // Id fields are re-checked at emit time: a value that bypassed the type
      // check (a cast or a non-TS caller) is dropped rather than written out.
      const format = ID_FIELD_FORMATS[key];
      if (format && !format.test(String(value))) continue;
      parts.push(`${key}=${value}`);
    }
    sink(parts.join(' '));
  };
}

export const log: Logger = createLogger(consoleSink);

// For modules that take an optional injected sink: no sink, no output.
export function loggerFor(sink: LogSink | undefined): Logger {
  return sink ? createLogger(sink) : () => {};
}
