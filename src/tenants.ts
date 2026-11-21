import { readFileSync } from 'node:fs';
import { TranscriptError } from './errors.js';

// Where a job came from. Discord origins carry the guild and the configured
// channel (never a thread id); web origins carry an identity string the
// operator chose for that web surface.
export type JobOrigin =
  | { kind: 'discord'; guild_id: string; channel_id: string }
  | { kind: 'web'; identity: string };

export type FileExtension = '.txt' | '.md' | '.srt';

export interface TenantDestination {
  type: 'google-drive' | 'none';
  folder_id?: string;
  extension?: FileExtension;
}

export interface Tenant {
  id: string;
  discord_guild_id?: string;
  discord_channel_ids?: string[];
  web_identities?: string[];
  destination?: TenantDestination;
}

const FILE_EXTENSIONS = new Set<string>(['.txt', '.md', '.srt']);

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function stringList(value: unknown, label: string, path: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((v) => !isNonEmptyString(v))) {
    throw new TranscriptError('invalid_config', `${path}: ${label} must be a list of non-empty strings`);
  }
  return value as string[];
}

function parseDestination(value: unknown, path: string): TenantDestination | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'object' || value === null) {
    throw new TranscriptError('invalid_config', `${path}: destination must be an object`);
  }
  const raw = value as Record<string, unknown>;
  if (raw.type === 'none') return { type: 'none' };
  if (raw.type !== 'google-drive') {
    throw new TranscriptError(
      'invalid_config',
      `${path}: destination.type must be "google-drive" or "none", got: ${String(raw.type)}`,
    );
  }
  if (!isNonEmptyString(raw.folder_id)) {
    throw new TranscriptError('invalid_config', `${path}: a google-drive destination needs a folder_id`);
  }
  const extension = raw.extension === undefined ? undefined : raw.extension;
  if (extension !== undefined && !FILE_EXTENSIONS.has(extension as string)) {
    throw new TranscriptError(
      'invalid_config',
      `${path}: destination.extension must be .txt, .md or .srt, got: ${String(extension)}`,
    );
  }
  return { type: 'google-drive', folder_id: raw.folder_id.trim(), extension: extension as FileExtension };
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
  const list = (parsed as { tenants?: unknown })?.tenants;
  if (!Array.isArray(list)) {
    throw new TranscriptError('invalid_config', `${path}: expected a JSON object with a "tenants" array`);
  }
  return list.map((entry, i) => {
    const path = `tenants[${i}]`;
    if (typeof entry !== 'object' || entry === null) {
      throw new TranscriptError('invalid_config', `${path}: each tenant must be an object`);
    }
    const raw = entry as Record<string, unknown>;
    if (!isNonEmptyString(raw.id)) {
      throw new TranscriptError('invalid_config', `${path}: each tenant needs a non-empty "id"`);
    }
    const tenant: Tenant = { id: raw.id.trim() };
    if (raw.discord_guild_id !== undefined) {
      if (!isNonEmptyString(raw.discord_guild_id)) {
        throw new TranscriptError('invalid_config', `${path}: discord_guild_id must be a non-empty string`);
      }
      tenant.discord_guild_id = raw.discord_guild_id.trim();
    }
    tenant.discord_channel_ids = stringList(raw.discord_channel_ids, 'discord_channel_ids', path);
    tenant.web_identities = stringList(raw.web_identities, 'web_identities', path);
    tenant.destination = parseDestination(raw.destination, path);
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
