import { createSign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { TranscriptError } from './errors.js';

// The Drive surface the saver needs: find a file inside one folder — by the
// stored video id first, by name as a fallback — create it, or replace its
// contents. Keeping it this small is what lets the tests run a full fake
// Drive offline.
export interface StoredFile {
  id: string;
  name: string;
  url: string;
}

export interface DriveStore {
  findFile(folderId: string, name: string): Promise<StoredFile | null>;
  // Finds the file whose appProperties.videoId matches. Stores that cannot
  // query file properties may leave it unimplemented; the saver falls back
  // to the name lookup.
  findFileByVideoId?(folderId: string, videoId: string): Promise<StoredFile | null>;
  createFile(
    folderId: string,
    name: string,
    content: string,
    mimeType: string,
    appProperties?: Record<string, string>,
  ): Promise<StoredFile>;
  updateFile(fileId: string, content: string, mimeType: string): Promise<StoredFile>;
}

declare const driveLinkBrand: unique symbol;

// A branded canonical Drive file link. Raw remote text reaches this type
// only through parseDriveLink, which accepts an https drive.google.com
// /file/d/<id>/view URL and renders it in canonical form. A caught error
// message, an embedded newline or another host can never wear the brand,
// so a reply sink that takes DriveLink cannot be handed arbitrary text.
export type DriveLink = string & { readonly [driveLinkBrand]: 'drive_link' };

const DRIVE_LINK_FORMAT = /^https:\/\/drive\.google\.com\/file\/d\/([A-Za-z0-9_-]{1,128})\/view(?:\?\S*)?$/;
const isDriveLink = (value: string): value is DriveLink => DRIVE_LINK_FORMAT.test(value);

export function parseDriveLink(value: unknown): DriveLink | undefined {
  if (typeof value !== 'string') return undefined;
  const id = DRIVE_LINK_FORMAT.exec(value)?.[1];
  if (id === undefined) return undefined;
  const canonical = `https://drive.google.com/file/d/${id}/view`;
  return isDriveLink(canonical) ? canonical : undefined;
}

export class DriveError extends Error {
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'DriveError';
    this.status = status;
  }
}

interface ServiceAccount {
  client_email: string;
  private_key: string;
}

// Remote and file JSON is unknown until checked; this narrows fields by name
// so no unchecked `as` stands between the wire and the code.
function field(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null && key in value
    ? Reflect.get(value, key)
    : undefined;
}

function loadServiceAccount(credentialsPath: string): ServiceAccount {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(credentialsPath, 'utf8'));
  } catch (err) {
    throw new TranscriptError(
      'invalid_config',
      `cannot read GOOGLE_APPLICATION_CREDENTIALS file ${credentialsPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const email = field(parsed, 'client_email');
  const key = field(parsed, 'private_key');
  if (typeof email !== 'string' || typeof key !== 'string') {
    throw new TranscriptError(
      'invalid_config',
      `${credentialsPath}: not a service account key file (needs client_email and private_key)`,
    );
  }
  return { client_email: email, private_key: key };
}

function base64url(input: string | Buffer): string {
  return Buffer.from(input).toString('base64url');
}

function signJwt(account: ServiceAccount, scope: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = base64url(
    JSON.stringify({
      iss: account.client_email,
      scope,
      aud: 'https://oauth2.googleapis.com/token',
      iat: now,
      exp: now + 3600,
    }),
  );
  const signature = createSign('RSA-SHA256')
    .update(`${header}.${claims}`)
    .sign(account.private_key);
  return `${header}.${claims}.${base64url(signature)}`;
}

const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const FILE_FIELDS = 'id,name,webViewLink';

function driveUrl(file: unknown): StoredFile {
  const idValue = field(file, 'id');
  const id = typeof idValue === 'string' ? idValue : '';
  const name = field(file, 'name');
  const link = field(file, 'webViewLink');
  return {
    id,
    name: typeof name === 'string' ? name : '',
    url:
      typeof link === 'string' && link !== ''
        ? link
        : `https://drive.google.com/file/d/${id}/view`,
  };
}

async function readApiError(res: Response): Promise<DriveError> {
  const shareHint =
    res.status === 403 ? ' — is the folder shared with the service account email?' : '';
  return new DriveError(`Drive API error ${res.status}${shareHint}`, res.status);
}

export interface DriveStoreOptions {
  credentialsPath: string;
  fetchImpl?: typeof fetch;
}

// A service account owns nothing a user can see; the tenant shares its Drive
// folder with the service account email, so drive.file scope is enough to
// read and write inside exactly that folder.
export function createDriveStore(options: DriveStoreOptions): DriveStore {
  const doFetch = options.fetchImpl ?? fetch;
  let account: ServiceAccount | undefined;
  let token: { value: string; expiresAt: number } | undefined;

  const serviceAccount = (): ServiceAccount => (account ??= loadServiceAccount(options.credentialsPath));

  async function accessToken(): Promise<string> {
    if (token && Date.now() < token.expiresAt - 60_000) return token.value;
    const res = await doFetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: signJwt(serviceAccount(), DRIVE_SCOPE),
      }).toString(),
    });
    if (!res.ok) throw await readApiError(res);
    const body: unknown = await res.json();
    const accessToken = field(body, 'access_token');
    if (typeof accessToken !== 'string' || accessToken === '') {
      throw new DriveError('token endpoint returned no access_token');
    }
    const expiresIn = field(body, 'expires_in');
    const ttl = typeof expiresIn === 'number' ? expiresIn : 3600;
    token = { value: accessToken, expiresAt: Date.now() + ttl * 1000 };
    return token.value;
  }

  async function api(url: string, init: RequestInit = {}): Promise<Response> {
    const bearer = await accessToken();
    const res = await doFetch(url, {
      ...init,
      headers: { authorization: `Bearer ${bearer}`, ...(init.headers ?? {}) },
    });
    if (!res.ok) throw await readApiError(res);
    return res;
  }

  const escape = (value: string): string => value.replaceAll("'", "\\'");

  async function search(q: string): Promise<StoredFile | null> {
    const res = await api(
      `${DRIVE_API}/files?q=${encodeURIComponent(q)}&fields=${encodeURIComponent(`files(${FILE_FIELDS})`)}&supportsAllDrives=true&includeItemsFromAllDrives=true&spaces=drive`,
    );
    const body: unknown = await res.json();
    const files = field(body, 'files');
    const found = Array.isArray(files) ? files[0] : undefined;
    return found === undefined ? null : driveUrl(found);
  }

  return {
    async findFile(folderId, name) {
      return search(`name='${escape(name)}' and '${escape(folderId)}' in parents and trashed=false`);
    },

    // The repeat-video lookup: the video id rides on the file's
    // appProperties, so a new title or a new capture day still lands on the
    // same file.
    async findFileByVideoId(folderId, videoId) {
      return search(
        `appProperties has {key='videoId' and value='${escape(videoId)}'} and '${escape(folderId)}' in parents and trashed=false`,
      );
    },

    async createFile(folderId, name, content, mimeType, appProperties) {
      const boundary = 'fa_transcript_boundary';
      const metadata = JSON.stringify({
        name,
        parents: [folderId],
        ...(appProperties === undefined ? {} : { appProperties }),
      });
      const body = [
        `--${boundary}`,
        'content-type: application/json; charset=UTF-8',
        '',
        metadata,
        `--${boundary}`,
        `content-type: ${mimeType}`,
        '',
        content,
        `--${boundary}--`,
        '',
      ].join('\r\n');
      const res = await api(
        `${DRIVE_UPLOAD}/files?uploadType=multipart&supportsAllDrives=true&fields=${encodeURIComponent(FILE_FIELDS)}`,
        {
          method: 'POST',
          headers: { 'content-type': `multipart/related; boundary=${boundary}` },
          body,
        },
      );
      return driveUrl(await res.json());
    },

    async updateFile(fileId, content, mimeType) {
      const res = await api(
        `${DRIVE_UPLOAD}/files/${encodeURIComponent(fileId)}?uploadType=media&supportsAllDrives=true&fields=${encodeURIComponent(FILE_FIELDS)}`,
        { method: 'PATCH', headers: { 'content-type': mimeType }, body: content },
      );
      return driveUrl(await res.json());
    },
  };
}
