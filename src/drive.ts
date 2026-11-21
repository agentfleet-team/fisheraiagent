import { createSign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { TranscriptError } from './errors.js';

// The Drive surface the saver needs: find a file by name inside one folder,
// create it, or replace its contents. Keeping it this small is what lets the
// tests run a full fake Drive offline.
export interface StoredFile {
  id: string;
  name: string;
  url: string;
}

export interface DriveStore {
  findFile(folderId: string, name: string): Promise<StoredFile | null>;
  createFile(folderId: string, name: string, content: string, mimeType: string): Promise<StoredFile>;
  updateFile(fileId: string, content: string, mimeType: string): Promise<StoredFile>;
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
  const account = parsed as Partial<ServiceAccount>;
  if (typeof account?.client_email !== 'string' || typeof account?.private_key !== 'string') {
    throw new TranscriptError(
      'invalid_config',
      `${credentialsPath}: not a service account key file (needs client_email and private_key)`,
    );
  }
  return { client_email: account.client_email, private_key: account.private_key };
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

function driveUrl(file: { id?: string; name?: string; webViewLink?: string }): StoredFile {
  const id = typeof file.id === 'string' ? file.id : '';
  return {
    id,
    name: typeof file.name === 'string' ? file.name : '',
    url:
      typeof file.webViewLink === 'string' && file.webViewLink !== ''
        ? file.webViewLink
        : `https://drive.google.com/file/d/${id}/view`,
  };
}

async function readApiError(res: Response): Promise<DriveError> {
  const body = (await res.json().catch(() => null)) as {
    error?: { message?: unknown };
  } | null;
  const detail = typeof body?.error?.message === 'string' ? ` ${body.error.message}` : '';
  const shareHint =
    res.status === 403 ? ' — is the folder shared with the service account email?' : '';
  return new DriveError(`Drive API error ${res.status}:${detail}${shareHint}`, res.status);
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
    const body = (await res.json()) as { access_token?: unknown; expires_in?: unknown };
    if (typeof body.access_token !== 'string' || body.access_token === '') {
      throw new DriveError('token endpoint returned no access_token');
    }
    const ttl = typeof body.expires_in === 'number' ? body.expires_in : 3600;
    token = { value: body.access_token, expiresAt: Date.now() + ttl * 1000 };
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

  return {
    async findFile(folderId, name) {
      const q = `name='${name.replaceAll("'", "\\'")}' and '${folderId.replaceAll("'", "\\'")}' in parents and trashed=false`;
      const res = await api(
        `${DRIVE_API}/files?q=${encodeURIComponent(q)}&fields=${encodeURIComponent(`files(${FILE_FIELDS})`)}&supportsAllDrives=true&includeItemsFromAllDrives=true&spaces=drive`,
      );
      const body = (await res.json()) as { files?: { id?: string; name?: string; webViewLink?: string }[] };
      const found = body.files?.[0];
      return found ? driveUrl(found) : null;
    },

    async createFile(folderId, name, content, mimeType) {
      const boundary = 'fa_transcript_boundary';
      const metadata = JSON.stringify({ name, parents: [folderId] });
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
      return driveUrl((await res.json()) as { id?: string; name?: string; webViewLink?: string });
    },

    async updateFile(fileId, content, mimeType) {
      const res = await api(
        `${DRIVE_UPLOAD}/files/${encodeURIComponent(fileId)}?uploadType=media&supportsAllDrives=true&fields=${encodeURIComponent(FILE_FIELDS)}`,
        { method: 'PATCH', headers: { 'content-type': mimeType }, body: content },
      );
      return driveUrl((await res.json()) as { id?: string; name?: string; webViewLink?: string });
    },
  };
}
