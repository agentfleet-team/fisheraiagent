// The only way code in src/ writes a log line. `event` is one of a fixed set
// of names and `fields` is a closed allowlist of ids, codes, counts and route
// templates. Nothing here accepts an Error or free text, so a boundary cannot
// put caught or request-derived text into a log line.

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
  | 'internal_error'
  | 'usage';

export interface LogFields {
  guild?: string;
  channel?: string;
  video?: string;
  route?: LogRoute;
  code?: LogCode;
  port?: number;
  count?: number;
  durationMs?: number;
}

export type LogSink = (line: string) => void;
export type Logger = (event: LogEvent, fields?: LogFields) => void;

const FIELD_ORDER = ['guild', 'channel', 'video', 'route', 'code', 'port', 'count', 'durationMs'] as const;

export const consoleSink: LogSink = (line) => console.log(line);

export function createLogger(sink: LogSink): Logger {
  return (event, fields = {}) => {
    const parts: string[] = [event];
    for (const key of FIELD_ORDER) {
      const value = fields[key];
      if (value !== undefined) parts.push(`${key}=${value}`);
    }
    sink(parts.join(' '));
  };
}

export const log: Logger = createLogger(consoleSink);

// For modules that take an optional injected sink: no sink, no output.
export function loggerFor(sink: LogSink | undefined): Logger {
  return sink ? createLogger(sink) : () => {};
}
