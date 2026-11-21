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
// origin is a claim, not proof: the service trusts a claim only when the
// caller presents the credential the resolved tenant names, and a web
// claim never resolves — web callers have no tenant until sign-in (#6).
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

export interface Tenant {
  id: TenantId;
  discord_guild_id?: string;
  discord_channel_ids?: string[];
  caller?: TenantCaller;
  destination?: TenantDestination;
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
    tenant.caller = parseCaller(field(entry, 'caller'), path);
    tenant.destination = parseDestination(field(entry, 'destination'), path);
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
// channel-scoped entry took. First matching entry wins. A web origin never
// resolves: a web caller is anonymous until sign-in (#6), so it has no
// tenant and saves nothing.
export function resolveTenant(tenants: Tenant[], origin: JobOrigin): Tenant | undefined {
  if (origin.kind === 'web') return undefined;
  const scoped = tenants.find(
    (t) => t.discord_guild_id === origin.guild_id && t.discord_channel_ids?.includes(origin.channel_id),
  );
  if (scoped) return scoped;
  return tenants.find(
    (t) => t.discord_guild_id === origin.guild_id && (t.discord_channel_ids ?? []).length === 0,
  );
}
