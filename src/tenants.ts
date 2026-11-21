import { createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { TranscriptError } from './errors.js';
import {
  parseDriveFolderId,
  parseTenantId,
  type DriveFolderId,
  type TenantId,
} from './ids.js';

// Where a job came from. Discord origins carry the guild and the configured
// channel (never a thread id); web origins carry an identity string. The
// origin is a claim, not proof: the service trusts a discord claim only when
// the caller presents the credential the resolved tenant names, and a web
// identity is trusted only when it comes from a verified sign-in session —
// the session's email is the authenticated caller for the tenant whose
// web_emails allowlists it. A web identity a request merely asserts never
// reaches resolveTenant.
export type JobOrigin =
  | { kind: 'discord'; guild_id: string; channel_id: string }
  | { kind: 'web'; identity: string };

export type FileExtension = '.txt' | '.md' | '.srt';

export type TenantDestination =
  | { type: 'none' }
  | { type: 'google-drive'; folder_id: DriveFolderId; extension?: FileExtension };

// The credential a caller must present before the service trusts its
// origin claim for this tenant: either the hex SHA-256 of the caller's
// bearer token, or the name of an environment variable that holds the
// token itself. Exactly one of the two fields is set.
export interface TenantCaller {
  token_sha256?: string;
  token_env?: string;
}

// Per-tenant limits. `max_video_seconds` rejects a job for a video longer
// than the limit (the fixed video_too_long message) as early as the length
// is known: from local metadata or the transcript cache before any Gemini
// call, or from the first model response's DURATION line before further
// calls. `jobs_per_hour` caps accepted submissions in a sliding hour (the
// fixed rate_limited message).
export interface TenantLimits {
  max_video_seconds?: number;
  jobs_per_hour?: number;
}

export interface Tenant {
  id: TenantId;
  discord_guild_id?: string;
  discord_channel_ids?: string[];
  web_emails?: string[];
  caller?: TenantCaller;
  destination?: TenantDestination;
  limits?: TenantLimits;
}

// File data is unknown until checked; this narrows fields by name so no
// unchecked `as` stands between the tenants file and the code.
function field(value: object, key: string): unknown {
  return key in value ? Reflect.get(value, key) : undefined;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function isFileExtension(value: unknown): value is FileExtension {
  return value === '.txt' || value === '.md' || value === '.srt';
}

function stringList(value: unknown, label: string, path: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new TranscriptError('invalid_config', `${path}: ${label} must be a list of non-empty strings`);
  }
  const out: string[] = [];
  for (const v of value) {
    if (!isNonEmptyString(v)) {
      throw new TranscriptError('invalid_config', `${path}: ${label} must be a list of non-empty strings`);
    }
    out.push(v);
  }
  return out;
}

function parseDestination(value: unknown, path: string): TenantDestination | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'object' || value === null) {
    throw new TranscriptError('invalid_config', `${path}: destination must be an object`);
  }
  const type = field(value, 'type');
  if (type === 'none') return { type: 'none' };
  if (type !== 'google-drive') {
    throw new TranscriptError(
      'invalid_config',
      `${path}: destination.type must be "google-drive" or "none"`,
    );
  }
  const rawFolderId = field(value, 'folder_id');
  if (!isNonEmptyString(rawFolderId)) {
    throw new TranscriptError('invalid_config', `${path}: a google-drive destination needs a folder_id`);
  }
  const folder_id = parseDriveFolderId(rawFolderId.trim());
  if (!folder_id) {
    throw new TranscriptError('invalid_config', `${path}: folder_id is not a Drive folder id`);
  }
  const rawExtension = field(value, 'extension');
  if (rawExtension !== undefined && !isFileExtension(rawExtension)) {
    throw new TranscriptError(
      'invalid_config',
      `${path}: destination.extension must be .txt, .md or .srt`,
    );
  }
  const destination: TenantDestination = { type: 'google-drive', folder_id };
  if (rawExtension !== undefined && isFileExtension(rawExtension)) destination.extension = rawExtension;
  return destination;
}

function parseCaller(value: unknown, path: string): TenantCaller | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'object' || value === null) {
    throw new TranscriptError('invalid_config', `${path}: caller must be an object`);
  }
  const caller: TenantCaller = {};
  const sha = field(value, 'token_sha256');
  if (sha !== undefined) {
    if (typeof sha !== 'string' || !/^[0-9a-f]{64}$/.test(sha)) {
      throw new TranscriptError(
        'invalid_config',
        `${path}: caller.token_sha256 must be the lowercase hex SHA-256 of the caller's bearer token`,
      );
    }
    caller.token_sha256 = sha;
  }
  const env = field(value, 'token_env');
  if (env !== undefined) {
    if (!isNonEmptyString(env)) {
      throw new TranscriptError('invalid_config', `${path}: caller.token_env must be a non-empty env var name`);
    }
    caller.token_env = env.trim();
  }
  if (caller.token_sha256 === undefined && caller.token_env === undefined) {
    throw new TranscriptError('invalid_config', `${path}: caller needs token_sha256 or token_env`);
  }
  return caller;
}

function parseLimits(value: unknown, path: string): TenantLimits | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'object' || value === null) {
    throw new TranscriptError('invalid_config', `${path}: limits must be an object`);
  }
  const limits: TenantLimits = {};
  const seconds = field(value, 'max_video_seconds');
  if (seconds !== undefined) {
    if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) {
      throw new TranscriptError('invalid_config', `${path}: limits.max_video_seconds must be a positive number`);
    }
    limits.max_video_seconds = seconds;
  }
  const perHour = field(value, 'jobs_per_hour');
  if (perHour !== undefined) {
    if (typeof perHour !== 'number' || !Number.isInteger(perHour) || perHour <= 0) {
      throw new TranscriptError('invalid_config', `${path}: limits.jobs_per_hour must be a positive integer`);
    }
    limits.jobs_per_hour = perHour;
  }
  return limits;
}

// The tenants file is JSON read fresh on every job submit, so adding a tenant
// is an edit to one file — never a code change or a restart:
// {
//   "tenants": [
//     {
//       "id": "family",
//       "discord_guild_id": "111",
//       "discord_channel_ids": ["222", "333"],
//       "caller": { "token_env": "BOT_SERVICE_TOKEN" },
//       "destination": { "type": "google-drive", "folder_id": "0AbC...", "extension": ".md" }
//     }
//   ]
// }
export function loadTenantsFile(path: string): Tenant[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new TranscriptError(
      'invalid_config',
      `cannot read tenants file ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return parseTenantsDocument(parsed, path);
}

// A tenants document may also come inline from an environment variable
// (TENANTS_JSON) — the same JSON, delivered by a secrets manager without a
// mounted file.
export function parseTenantsJson(text: string, source: string): Tenant[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new TranscriptError('invalid_config', `${source}: not valid JSON`);
  }
  return parseTenantsDocument(parsed, source);
}

function parseTenantsDocument(parsed: unknown, path: string): Tenant[] {
  const list = typeof parsed === 'object' && parsed !== null ? field(parsed, 'tenants') : undefined;
  if (!Array.isArray(list)) {
    throw new TranscriptError('invalid_config', `${path}: expected a JSON object with a "tenants" array`);
  }
  return list.map((entry, i) => {
    const path = `tenants[${i}]`;
    if (typeof entry !== 'object' || entry === null) {
      throw new TranscriptError('invalid_config', `${path}: each tenant must be an object`);
    }
    const rawId = field(entry, 'id');
    const id = isNonEmptyString(rawId) ? parseTenantId(rawId.trim()) : undefined;
    if (!id) {
      throw new TranscriptError(
        'invalid_config',
        `${path}: each tenant needs an "id" slug (lowercase letters, digits, - or _)`,
      );
    }
    const tenant: Tenant = { id };
    const guildId = field(entry, 'discord_guild_id');
    if (guildId !== undefined) {
      if (!isNonEmptyString(guildId)) {
        throw new TranscriptError('invalid_config', `${path}: discord_guild_id must be a non-empty string`);
      }
      tenant.discord_guild_id = guildId.trim();
    }
    tenant.discord_channel_ids = stringList(field(entry, 'discord_channel_ids'), 'discord_channel_ids', path);
    const emails = stringList(field(entry, 'web_emails'), 'web_emails', path);
    if (emails !== undefined) tenant.web_emails = emails.map((e) => e.toLowerCase());
    tenant.caller = parseCaller(field(entry, 'caller'), path);
    tenant.destination = parseDestination(field(entry, 'destination'), path);
    tenant.limits = parseLimits(field(entry, 'limits'), path);
    return tenant;
  });
}

// Whether the bearer token a caller presented is the credential the tenant
// entry names. A tenant without a caller credential cannot be claimed.
export function callerAuthorized(tenant: Tenant, presentedToken: string | undefined): boolean {
  const caller = tenant.caller;
  if (!caller || presentedToken === undefined) return false;
  if (caller.token_sha256 !== undefined) {
    const digest = createHash('sha256').update(presentedToken).digest('hex');
    return timingSafeEqual(Buffer.from(digest), Buffer.from(caller.token_sha256));
  }
  if (caller.token_env !== undefined) {
    const expected = (process.env[caller.token_env] ?? '').trim();
    return (
      expected !== '' &&
      expected.length === presentedToken.length &&
      timingSafeEqual(Buffer.from(expected), Buffer.from(presentedToken))
    );
  }
  return false;
}

// A channel-scoped entry (guild + channel list) claims only the listed
// channels; a guild-wide entry (guild only) claims every channel that no
// channel-scoped entry took. A web origin resolves only through the
// allowlisted `web_emails` of a tenant — and only the service may build
// such an origin, from a verified sign-in session; a request's own "web"
// claim never reaches this function. First matching entry wins.
export function resolveTenant(tenants: Tenant[], origin: JobOrigin): Tenant | undefined {
  if (origin.kind === 'web') {
    const email = origin.identity.toLowerCase();
    return tenants.find((t) => (t.web_emails ?? []).some((e) => e.toLowerCase() === email));
  }
  const scoped = tenants.find(
    (t) => t.discord_guild_id === origin.guild_id && t.discord_channel_ids?.includes(origin.channel_id),
  );
  if (scoped) return scoped;
  return tenants.find(
    (t) => t.discord_guild_id === origin.guild_id && (t.discord_channel_ids ?? []).length === 0,
  );
}

const HOUR_MS = 60 * 60 * 1000;

// Sliding-window count of accepted submissions per tenant, for the
// jobs_per_hour limit. In-memory only: a restart resets the window, which
// errs toward letting a few extra jobs through rather than blocking work.
export class TenantRateLimiter {
  private readonly hits = new Map<TenantId, number[]>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  // Records one submission and reports whether it is within the limit.
  allow(tenant: TenantId, jobsPerHour: number): boolean {
    const cutoff = this.now() - HOUR_MS;
    const recent = (this.hits.get(tenant) ?? []).filter((t) => t > cutoff);
    if (recent.length >= jobsPerHour) {
      this.hits.set(tenant, recent);
      return false;
    }
    recent.push(this.now());
    this.hits.set(tenant, recent);
    return true;
  }
}
