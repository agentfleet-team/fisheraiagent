import { DriveError, type DriveStore } from './drive.js';
import { TranscriptError } from './errors.js';
import { loadTenantsFile, resolveTenant, type FileExtension, type JobOrigin } from './tenants.js';
import type { Transcript } from './transcript.js';
import { canonicalVideoUrl } from './youtube-url.js';

export interface SavedFile {
  type: 'google-drive';
  name: string;
  url: string;
}

export interface VideoMetadata {
  title?: string;
  channel?: string;
}

export class SaveFailedError extends Error {
  readonly code = 'save_failed' as const;

  constructor(message: string) {
    super(message);
    this.name = 'SaveFailedError';
  }
}

const MIME_TYPES: Record<FileExtension, string> = {
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.srt': 'application/x-subrip',
};

function pad(n: number, width = 2): string {
  return String(n).padStart(width, '0');
}

// Lowercase ASCII slug: "My Great Video!" -> "my-great-video". A title that
// slugs to nothing (all non-ASCII) falls back to the video id, which is
// already filename-safe.
export function englishSlug(title: string, fallback: string): string {
  const slug = title
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
  return slug || fallback;
}

function clock(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

function srtStamp(seconds: number): string {
  const total = Math.max(0, seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = Math.floor(total % 60);
  const ms = Math.round((total - Math.floor(total)) * 1000);
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(ms, 3)}`;
}

// The file name is <english-slug>_<YYYYMMDD>.<ext>: the slug from the video
// title, the capture date in UTC, and the tenant's chosen extension.
export function transcriptFileName(
  title: string,
  videoId: string,
  extension: FileExtension,
  now: Date,
): string {
  const day = now.toISOString().slice(0, 10).replace(/-/g, '');
  return `${englishSlug(title, videoId)}_${day}${extension}`;
}

// Header first — title, channel, source URL, capture date — then the
// timestamped text in the format the extension names.
export function renderTranscriptFile(
  transcript: Transcript,
  meta: VideoMetadata,
  extension: FileExtension,
  now: Date,
): string {
  const title = meta.title?.trim() || transcript.video_id;
  const channel = meta.channel?.trim() || 'unknown';
  const header =
    `Title: ${title}\n` +
    `Channel: ${channel}\n` +
    `Source: ${transcript.source_url}\n` +
    `Captured: ${now.toISOString().slice(0, 10)}\n\n`;
  if (extension === '.srt') {
    const cues = transcript.blocks
      .map((b, i) => `${i + 1}\n${srtStamp(b.start)} --> ${srtStamp(b.end)}\n${b.text}`)
      .join('\n\n');
    return `${header}${cues}\n`;
  }
  const lines = transcript.blocks.map((b) => `[${clock(b.start)}] ${b.text}`).join('\n');
  return `${header}${lines}\n`;
}

// YouTube oEmbed needs no key and gives exactly the two fields the file
// header needs. It is best-effort: a failure leaves the title as the video id.
export function createVideoMetadata(
  fetchImpl: typeof fetch = fetch,
): (videoId: string) => Promise<VideoMetadata> {
  return async (videoId) => {
    try {
      const url = `https://www.youtube.com/oembed?url=${encodeURIComponent(canonicalVideoUrl(videoId))}&format=json`;
      const res = await fetchImpl(url);
      if (!res.ok) return {};
      const body = (await res.json()) as { title?: unknown; author_name?: unknown };
      return {
        title: typeof body.title === 'string' ? body.title : undefined,
        channel: typeof body.author_name === 'string' ? body.author_name : undefined,
      };
    } catch {
      return {};
    }
  };
}

export interface SaverDeps {
  tenantsFile: string;
  drive?: DriveStore;
  metadata?: (videoId: string) => Promise<VideoMetadata>;
  now?: () => Date;
  log?: (line: string) => void;
}

// Returns the after-job hook the job runner calls once a transcript exists.
// Resolving to no tenant, or to a "none" destination, saves nothing and is not
// an error. Real failures throw; the job records them as save_error and the
// transcript is still returned.
export function createTranscriptSaver(
  deps: SaverDeps,
): (origin: JobOrigin, transcript: Transcript) => Promise<SavedFile | undefined> {
  const metadata = deps.metadata ?? createVideoMetadata();
  return async (origin, transcript) => {
    const tenants = loadTenantsFile(deps.tenantsFile);
    const tenant = resolveTenant(tenants, origin);
    const destination = tenant?.destination;
    if (!tenant || !destination || destination.type === 'none') return undefined;

    if (!deps.drive) {
      throw new TranscriptError(
        'invalid_config',
        `tenant ${tenant.id}: a google-drive destination needs GOOGLE_APPLICATION_CREDENTIALS`,
      );
    }
    const meta = await metadata(transcript.video_id);
    const now = deps.now?.() ?? new Date();
    const extension = destination.extension ?? '.txt';
    const title = meta.title?.trim() || transcript.video_id;
    const name = transcriptFileName(title, transcript.video_id, extension, now);
    const content = renderTranscriptFile(transcript, meta, extension, now);

    try {
      const existing = await deps.drive.findFile(destination.folder_id ?? '', name);
      const stored = existing
        ? await deps.drive.updateFile(existing.id, content, MIME_TYPES[extension])
        : await deps.drive.createFile(destination.folder_id ?? '', name, content, MIME_TYPES[extension]);
      deps.log?.(`saved ${transcript.video_id} tenant=${tenant.id} file=${stored.name}`);
      return { type: 'google-drive', name: stored.name, url: stored.url };
    } catch (err) {
      const detail = err instanceof DriveError ? err.message : err instanceof Error ? err.message : String(err);
      throw new SaveFailedError(`could not save ${transcript.video_id} for tenant ${tenant.id}: ${detail}`);
    }
  };
}
