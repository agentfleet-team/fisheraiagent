import { DriveError, parseDriveLink, type DriveLink, type DriveStore, type StoredFile } from './drive.js';
import { TranscriptError } from './errors.js';
import { parseDriveFileId, parseVideoId } from './ids.js';
import { loggerFor, type LogFields, type LogSink } from './log.js';
import { loadTenantsFile, resolveTenant, type FileExtension, type JobOrigin } from './tenants.js';
import type { Transcript } from './transcript.js';
import {
  createWebdavStore,
  WebdavError,
  webdavPassword,
  type WebdavPath,
  type WebdavStoredFile,
} from './webdav.js';
import { canonicalVideoUrl } from './youtube-url.js';

// The saved-file link a job view and a reply may carry: for Drive the url is
// branded DriveLink — raw Drive response text only after parseDriveLink has
// rendered it canonical — and for WebDAV the path is branded WebdavPath,
// only ever the canonical rendering of the configured folder plus a safe
// file name; folder travels with it so a client can re-render and re-check
// the path instead of trusting a wire string. Neither can be a channel for
// arbitrary remote text.
export type SavedFile =
  | { type: 'google-drive'; name: string; url: DriveLink }
  | { type: 'webdav'; name: string; folder: string; path: WebdavPath };

export interface VideoMetadata {
  title?: string;
  channel?: string;
}

export class SaveFailedError extends Error {
  readonly code: 'save_failed' = 'save_failed';
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'SaveFailedError';
    this.status = status;
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

// The file name is <english-slug>_<videoId>_<YYYYMMDD>.<ext>: the slug
// from the video title, the video id (file identity is the video, not the
// title), the capture date in UTC, and the tenant's chosen extension.
export function transcriptFileName(
  title: string,
  videoId: string,
  extension: FileExtension,
  now: Date,
): string {
  const day = now.toISOString().slice(0, 10).replace(/-/g, '');
  return `${englishSlug(title, videoId)}_${videoId}_${day}${extension}`;
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
      const body: unknown = await res.json();
      const record = typeof body === 'object' && body !== null ? body : {};
      const title = 'title' in record ? Reflect.get(record, 'title') : undefined;
      const channel = 'author_name' in record ? Reflect.get(record, 'author_name') : undefined;
      return {
        title: typeof title === 'string' ? title : undefined,
        channel: typeof channel === 'string' ? channel : undefined,
      };
    } catch {
      return {};
    }
  };
}

export interface SaverDeps {
  tenantsFile: string;
  drive?: DriveStore;
  webdavFetch?: typeof fetch;
  metadata?: (videoId: string) => Promise<VideoMetadata>;
  now?: () => Date;
  log?: LogSink;
}

// Returns the after-job hook the job runner calls once a transcript exists.
// Resolving to no tenant, or to a "none" destination, saves nothing and is not
// an error. Real failures throw; the job records them as save_error and the
// transcript is still returned. The origin here is an already-verified claim:
// the HTTP boundary is what authenticates the caller against the tenant's
// caller credential before a claim is allowed to reach this hook.
export function createTranscriptSaver(
  deps: SaverDeps,
): (origin: JobOrigin, transcript: Transcript) => Promise<SavedFile | undefined> {
  const metadata = deps.metadata ?? createVideoMetadata();
  const log = loggerFor(deps.log);
  // File identity is tenant + video id, held in memory here and persisted on
  // the Drive file's appProperties. Writes for one identity serialize on a
  // promise chain so concurrent jobs converge on one file instead of racing
  // a find/create pair into a duplicate.
  const locks = new Map<string, Promise<unknown>>();
  const known = new Map<string, StoredFile>();
  const knownWebdav = new Map<string, WebdavStoredFile>();
  const enqueue = <T>(key: string, fn: () => Promise<T>): Promise<T> => {
    const next = (locks.get(key) ?? Promise.resolve()).then(fn, fn);
    locks.set(
      key,
      next.then(
        () => undefined,
        () => undefined,
      ),
    );
    return next;
  };
  return async (origin, transcript) => {
    const tenants = loadTenantsFile(deps.tenantsFile);
    const tenant = resolveTenant(tenants, origin);
    const destination = tenant?.destination;
    if (!tenant || !destination || destination.type === 'none') return undefined;

    const fields: LogFields = {
      tenant: tenant.id,
      video: parseVideoId(transcript.video_id),
      dest: destination.type,
    };
    const key = `${tenant.id}:${transcript.video_id}`;
    if (destination.type === 'webdav') {
      let store: ReturnType<typeof createWebdavStore>;
      try {
        store = createWebdavStore({
          baseUrl: destination.base_url,
          path: destination.path,
          username: destination.username,
          password: webdavPassword(destination.password_env),
          fetchImpl: deps.webdavFetch,
        });
      } catch (err) {
        log('file_save_failed', { ...fields, code: 'invalid_config' });
        throw err;
      }
      return enqueue(key, async () => {
        const meta = await metadata(transcript.video_id);
        const now = deps.now?.() ?? new Date();
        const extension = destination.extension ?? '.txt';
        const title = meta.title?.trim() || transcript.video_id;
        const name = transcriptFileName(title, transcript.video_id, extension, now);
        const content = renderTranscriptFile(transcript, meta, extension, now);

        try {
          const found =
            knownWebdav.get(key) ?? (await store.findFileByVideoId(transcript.video_id));
          const stored = found
            ? await store.updateFile(found.id, content, MIME_TYPES[extension])
            : await store.createFile(name, content, MIME_TYPES[extension]);
          knownWebdav.set(key, stored);
          log('file_saved', fields);
          return { type: 'webdav', name: stored.name, folder: destination.path, path: stored.path };
        } catch (err) {
          knownWebdav.delete(key);
          log('file_save_failed', { ...fields, code: 'save_failed' });
          const status = err instanceof WebdavError ? err.status : undefined;
          throw new SaveFailedError('the destination write failed', status);
        }
      });
    }

    const driveFields: LogFields = { ...fields, folder: destination.folder_id };
    if (!deps.drive) {
      log('file_save_failed', { ...driveFields, code: 'invalid_config' });
      throw new TranscriptError(
        'invalid_config',
        `tenant ${tenant.id}: a google-drive destination needs GOOGLE_APPLICATION_CREDENTIALS`,
      );
    }
    const drive = deps.drive;
    return enqueue(key, async () => {
      const meta = await metadata(transcript.video_id);
      const now = deps.now?.() ?? new Date();
      const extension = destination.extension ?? '.txt';
      const title = meta.title?.trim() || transcript.video_id;
      const name = transcriptFileName(title, transcript.video_id, extension, now);
      const content = renderTranscriptFile(transcript, meta, extension, now);

      try {
        let stored =
          known.get(key) ??
          (await drive.findFileByVideoId(destination.folder_id, transcript.video_id));
        stored = stored
          ? await drive.updateFile(stored.id, content, MIME_TYPES[extension])
          : await drive.createFile(destination.folder_id, name, content, MIME_TYPES[extension], {
              videoId: transcript.video_id,
            });
        const url = parseDriveLink(stored.url);
        if (!url) throw new DriveError('the Drive response carried no usable file link');
        known.set(key, stored);
        log('file_saved', { ...driveFields, file: parseDriveFileId(stored.id) });
        return { type: 'google-drive', name: stored.name, url };
      } catch (err) {
        known.delete(key);
        log('file_save_failed', { ...driveFields, code: 'save_failed' });
        const status = err instanceof DriveError ? err.status : undefined;
        throw new SaveFailedError('the destination write failed', status);
      }
    });
  };
}
