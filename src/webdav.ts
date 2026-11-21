import { TranscriptError } from './errors.js';

// The NAS destination: an HTTPS WebDAV folder the tenant names in its
// destination entry. Three branded/validated surfaces keep this safe:
// WebdavBaseUrl exists only for an https:// URL with no embedded credential,
// WebdavPath is the only shape of path a reply may show, and every file name
// or update target is confined under the configured folder before a request
// is built. Passwords arrive only through the env var the config names;
// upstream response text is never read into an error or a log.

declare const webdavBaseUrlBrand: unique symbol;

// An https:// base URL (no credentials, query or fragment) that only
// parseWebdavBaseUrl can produce.
export type WebdavBaseUrl = string & { readonly [webdavBaseUrlBrand]: 'webdav_base_url' };

const isWebdavBaseUrl = (value: string): value is WebdavBaseUrl => value.startsWith('https://');

export function parseWebdavBaseUrl(value: unknown): WebdavBaseUrl | undefined {
  if (typeof value !== 'string' || value === '' || value.trim() !== value) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:') return undefined;
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    return undefined;
  }
  const canonical = `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
  return isWebdavBaseUrl(canonical) ? canonical : undefined;
}

declare const webdavPathBrand: unique symbol;

// A path a reply may show: it comes only from parseWebdavPath, which rejects
// control characters, backslashes and ".." segments, so remote or caught
// text cannot reach a person through it.
export type WebdavPath = string & { readonly [webdavPathBrand]: 'webdav_path' };

const isWebdavPath = (value: string): value is WebdavPath => value.startsWith('/');

export function parseWebdavPath(value: unknown): WebdavPath | undefined {
  if (typeof value !== 'string') return undefined;
  if (!value.startsWith('/') || value.length > 1000) return undefined;
  if (/[\u0000-\u001f\u007f\\]/.test(value)) return undefined;
  if (value.split('/').some((s) => s === '..')) return undefined;
  return isWebdavPath(value) ? value : undefined;
}

// The tenant's configured folder, as checked segments: no "." or "..", no
// backslash, no control characters. Returned as the decoded segments; each
// is percent-encoded when a request URL is built.
export function parseWebdavFolder(value: unknown): string[] | undefined {
  if (typeof value !== 'string') return undefined;
  const segments = value
    .trim()
    .split('/')
    .filter((s) => s !== '');
  if (segments.length === 0) return undefined;
  for (const s of segments) {
    if (s === '.' || s === '..' || s.includes('\\') || /[\u0000-\u001f\u007f]/.test(s)) {
      return undefined;
    }
  }
  return segments;
}

export class WebdavError extends Error {
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'WebdavError';
    this.status = status;
  }
}

export interface WebdavStoredFile {
  id: string; // decoded path under the configured folder; the update target
  name: string; // safe-charset basename
  path: WebdavPath; // the path a reply may show
}

export interface WebdavStore {
  // Finds the stored file whose name carries this video id, inside the
  // configured folder only.
  findFileByVideoId(videoId: string): Promise<WebdavStoredFile | null>;
  createFile(name: string, content: string, mimeType: string): Promise<WebdavStoredFile>;
  updateFile(id: string, content: string, mimeType: string): Promise<WebdavStoredFile>;
}

// A WebDAV file name is one safe-charset segment: letters, digits and
// ._- only, never a dot name, never a slash or percent. Anything else is
// refused before a URL is built, so a hostile title or video id cannot
// escape the configured folder.
const FILE_NAME_FORMAT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/;
const isSafeFileName = (name: string): boolean => FILE_NAME_FORMAT.test(name);

// File identity is the video id inside the file name: our writer produces
// <slug>_<videoId>_<YYYYMMDD>.<ext> where the slug has no underscore, except
// the empty-slug fallback where it is the video id itself. The match is
// anchored, so a different video id that merely contains this one cannot
// match.
export function nameMatchesVideoId(name: string, videoId: string): boolean {
  const esc = videoId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^(?:[a-z0-9-]+_|${esc}_)${esc}_\\d{8}\\.[a-z]+$`).test(name);
}

export interface WebdavOptions {
  baseUrl: WebdavBaseUrl;
  path: string; // normalized configured folder, "/a/b" form
  username: string;
  password: string;
  fetchImpl?: typeof fetch;
}

export function createWebdavStore(options: WebdavOptions): WebdavStore {
  const doFetch = options.fetchImpl ?? fetch;
  const basic = Buffer.from(`${options.username}:${options.password}`, 'utf8').toString('base64');
  const authorization = `Basic ${basic}`;
  const folderSegments = options.path.split('/').filter((s) => s !== '');
  const folderPrefix = `${options.path}/`;

  const url = (segments: string[]): string =>
    `${options.baseUrl}/${segments.map(encodeURIComponent).join('/')}`;
  const folderUrl = (): string => url(folderSegments);
  const fileUrl = (name: string): string => url([...folderSegments, name]);

  const request = async (method: string, target: string, init: RequestInit = {}): Promise<Response> =>
    doFetch(target, {
      ...init,
      method,
      headers: { authorization, ...(init.headers ?? {}) },
    });

  const shown = (decodedPath: string, name: string): WebdavStoredFile => {
    const path = parseWebdavPath(decodedPath);
    if (path === undefined) throw new WebdavError('the configured folder path cannot be shown');
    return { id: decodedPath, name, path };
  };

  // The update target must be a file directly under the configured folder:
  // an id from a directory listing or memory is trusted only after it
  // resolves to <configured>/<safe basename>.
  const targetName = (id: string): string => {
    if (!id.startsWith(folderPrefix)) {
      throw new WebdavError('the update target is outside the configured folder');
    }
    const name = id.slice(folderPrefix.length);
    if (!isSafeFileName(name)) {
      throw new WebdavError('the update target is outside the configured folder');
    }
    return name;
  };

  // Decoded paths of the direct children in a PROPFIND body. Only entries
  // strictly under the configured folder with a safe basename survive; an
  // href that decodes elsewhere, carries a query, or is malformed is skipped.
  const listedNames = (body: string): { decoded: string; name: string }[] => {
    const out: { decoded: string; name: string }[] = [];
    for (const match of body.matchAll(/<(?:[A-Za-z0-9_]+:)?href\b[^>]*>([^<]*)<\//g)) {
      const raw = match[1]?.trim();
      if (raw === undefined || raw === '') continue;
      let decoded: string;
      try {
        decoded = decodeURIComponent(raw.startsWith('http') ? new URL(raw).pathname : raw);
      } catch {
        continue;
      }
      if (!decoded.startsWith(folderPrefix)) continue;
      const name = decoded.slice(folderPrefix.length);
      if (!isSafeFileName(name)) continue;
      out.push({ decoded, name });
    }
    return out;
  };

  const put = async (name: string, content: string, mimeType: string): Promise<Response> =>
    request('PUT', fileUrl(name), {
      headers: { 'content-type': mimeType },
      body: content,
    });

  const write = async (name: string, content: string, mimeType: string): Promise<WebdavStoredFile> => {
    let res = await put(name, content, mimeType);
    if (res.status === 404 || res.status === 409) {
      // The configured folder is missing: MKCOL creates exactly that one
      // folder, never an ancestor outside it and never anything else.
      const mk = await request('MKCOL', folderUrl());
      if (!mk.ok && mk.status !== 405) {
        throw new WebdavError(`WebDAV error ${mk.status}`, mk.status);
      }
      res = await put(name, content, mimeType);
    }
    if (!res.ok) throw new WebdavError(`WebDAV error ${res.status}`, res.status);
    return shown(`${folderPrefix}${name}`, name);
  };

  return {
    async findFileByVideoId(videoId) {
      const res = await request('PROPFIND', folderUrl(), { headers: { depth: '1' } });
      if (res.status === 404) return null;
      if (!res.ok) throw new WebdavError(`WebDAV error ${res.status}`, res.status);
      const body = await res.text();
      for (const entry of listedNames(body)) {
        if (nameMatchesVideoId(entry.name, videoId)) return shown(entry.decoded, entry.name);
      }
      return null;
    },

    async createFile(name, content, mimeType) {
      if (!isSafeFileName(name)) throw new WebdavError('the file name is not a safe path segment');
      return write(name, content, mimeType);
    },

    async updateFile(id, content, mimeType) {
      const name = targetName(id);
      return write(name, content, mimeType);
    },
  };
}

// The password env var read: the config file names the variable, the value
// lives only in the process environment. Missing is a config error, fixed.
export function webdavPassword(envVar: string): string {
  const password = (process.env[envVar] ?? '').trim();
  if (password === '') {
    throw new TranscriptError('invalid_config', `a webdav destination needs the ${envVar} environment variable set`);
  }
  return password;
}
