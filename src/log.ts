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

export type LogEvent =
  | 'http_request'
  | 'http_unhandled_error'
  | 'service_listening'
  | 'cache_hit'
  | 'key_set'
  | 'key_removed'
  | 'channel_enabled'
  | 'channel_disabled'
  | 'job_submitted'
  | 'job_done'
  | 'job_failed'
  | 'file_saved'
  | 'file_save_failed'
  | 'discord_ready'
  | 'commands_registered'
  | 'command_registration_failed'
  | 'message_handler_failed'
  | 'command_handler_failed'
  | 'startup_failed';

export type LogRoute = 'GET /healthz' | 'POST /v1/jobs' | 'GET /v1/jobs/:id' | 'other';

export type LogCode =
  | 'invalid_url'
  | 'video_unavailable'
  | 'missing_key'
  | 'key_rejected'
  | 'quota_exceeded'
  | 'upstream_timeout'
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
  | 'internal_error'
  | 'usage';

export interface LogFields {
  guild?: GuildId;
  channel?: ChannelId;
  tenant?: TenantId;
  video?: VideoId;
  job?: JobId;
  folder?: DriveFolderId;
  file?: DriveFileId;
  route?: LogRoute;
  code?: LogCode;
  port?: number;
  count?: number;
  durationMs?: number;
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
  'route',
  'code',
  'port',
  'count',
  'durationMs',
];

const ID_FIELD_FORMATS: Partial<Record<keyof LogFields, RegExp>> = ID_FORMATS;

export const consoleSink: LogSink = (line) => console.log(line);

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
