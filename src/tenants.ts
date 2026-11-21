import { readFileSync } from 'node:fs';
import { TranscriptError } from './errors.js';
import {
  parseDriveFolderId,
  parseTenantId,
  type DriveFolderId,
  type TenantId,
} from './ids.js';

// Where a job came from. Discord origins carry the guild and the configured
// channel (never a thread id); web origins carry an identity string the
// operator chose for that web surface.
export type JobOrigin =
  | { kind: 'discord'; guild_id: string; channel_id: string }
  | { kind: 'web'; identity: string };

export type FileExtension = '.txt' | '.md' | '.srt';

export type TenantDestination =
  | { type: 'none' }
  | { type: 'google-drive'; folder_id: DriveFolderId; extension?: FileExtension };

export interface Tenant {
  id: TenantId;
  discord_guild_id?: string;
  discord_channel_ids?: string[];
  web_identities?: string[];
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

// The tenants file is JSON read fresh on every job submit, so adding a tenant
// is an edit to one file — never a code change or a restart:
// {
//   "tenants": [
//     {
//       "id": "family",
//       "discord_guild_id": "111",
//       "discord_channel_ids": ["222", "333"],
//       "web_identities": ["allen"],
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
    tenant.web_identities = stringList(field(entry, 'web_identities'), 'web_identities', path);
    tenant.destination = parseDestination(field(entry, 'destination'), path);
    return tenant;
  });
}

// A channel-scoped entry (guild + channel list) claims only the listed
// channels; a guild-wide entry (guild only) claims every channel that no
// channel-scoped entry took. First matching entry wins.
export function resolveTenant(tenants: Tenant[], origin: JobOrigin): Tenant | undefined {
  if (origin.kind === 'discord') {
    const scoped = tenants.find(
      (t) => t.discord_guild_id === origin.guild_id && t.discord_channel_ids?.includes(origin.channel_id),
    );
    if (scoped) return scoped;
    return tenants.find(
      (t) => t.discord_guild_id === origin.guild_id && (t.discord_channel_ids ?? []).length === 0,
    );
  }
  return tenants.find((t) => t.web_identities?.includes(origin.identity));
}
