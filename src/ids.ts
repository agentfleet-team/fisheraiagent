// Validated identifier types. A raw string can reach one of these types only
// through the matching parse function, which returns undefined for any value
// that does not match the id's format — the invalid value is rejected and
// never becomes an id. Code that takes a branded id therefore cannot be
// handed arbitrary text (a caught error message, a request body or a remote
// payload) and have it survive as an id.

declare const idBrand: unique symbol;

export type GuildId = string & { readonly [idBrand]: 'guild' };
export type ChannelId = string & { readonly [idBrand]: 'channel' };
export type VideoId = string & { readonly [idBrand]: 'video' };
export type JobId = string & { readonly [idBrand]: 'job' };

// Discord ids are snowflakes: 17-20 decimal digits.
const SNOWFLAKE_FORMAT = /^\d{17,20}$/;
// YouTube video ids are exactly 11 characters of [A-Za-z0-9_-].
const VIDEO_ID_FORMAT = /^[A-Za-z0-9_-]{11}$/;
// Job ids are randomUUID() values from the job store.
const JOB_ID_FORMAT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Same checks as runtime data, for the logger's emit-time re-validation.
export const ID_FORMATS = {
  guild: SNOWFLAKE_FORMAT,
  channel: SNOWFLAKE_FORMAT,
  video: VIDEO_ID_FORMAT,
  job: JOB_ID_FORMAT,
} as const;

type IdKind = keyof typeof ID_FORMATS;

function parseId<Id>(kind: IdKind, value: string): Id | undefined {
  return ID_FORMATS[kind].test(value) ? (value as Id) : undefined;
}

export const parseGuildId = (value: string): GuildId | undefined => parseId<GuildId>('guild', value);
export const parseChannelId = (value: string): ChannelId | undefined =>
  parseId<ChannelId>('channel', value);
export const parseVideoId = (value: string): VideoId | undefined => parseId<VideoId>('video', value);
export const parseJobId = (value: string): JobId | undefined => parseId<JobId>('job', value);
