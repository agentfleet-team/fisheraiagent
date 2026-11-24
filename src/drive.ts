import { createSign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { TranscriptError } from './errors.js';

// The Drive surface the saver needs: find a file inside one folder by the
// video id stored on it, create it, or replace its contents. A file's name
// never identifies it. Keeping it this small is what lets the tests run a full fake
// Drive offline.
export interface StoredFile {
  id: string;
  name: string;
}

export interface DriveStore {
  // Finds the file whose appProperties.videoId matches.
  findFileByVideoId(folderId: string, videoId: string): Promise<StoredFile | null>;
  createFile(
    folderId: string,
    name: string,
    content: string,
    mimeType: string,
    appProperties?: Record<string, string>,
  ): Promise<StoredFile>;
  // Renames and rewrites in one call: the name is part of the request, so a
  // tenant that switches extension (.txt → .md) gets a renamed file, not a
  // stale name on new content.
  updateFile(
    fileId: string,
    name: string,
    content: string,
    mimeType: string,
  ): Promise<StoredFile>;
}

declare const driveLinkBrand: unique symbol;

// A branded canonical Drive file link. Raw remote text reaches this type
// only through parseDriveLink, which accepts an https drive.google.com
// /file/d/<id>/view URL and renders it in canonical form. A caught error
// message, an embedded newline or another host can never wear the brand,
// so a reply sink that takes DriveLink cannot be handed arbitrary text.
export type DriveLink = string & { readonly [driveLinkBrand]: 'drive_link' };

const DRIVE_LINK_FORMAT = /^https:\/\/drive\.google\.com\/file\/d\/([A-Za-z0-9_-]{1,128})\/view(?:\?\S*)?$/;
const DRIVE_FILE_ID_FORMAT = /^[A-Za-z0-9_-]{1,128}$/;
const isDriveLink = (value: string): value is DriveLink => DRIVE_LINK_FORMAT.test(value);

function canonicalDriveLink(id: string): DriveLink | undefined {
  if (!DRIVE_FILE_ID_FORMAT.test(id)) return undefined;
  const url = `https://drive.google.com/file/d/${id}/view`;
  return isDriveLink(url) ? url : undefined;
}

export function parseDriveLink(value: unknown): DriveLink | undefined {
  if (typeof value !== 'string') return undefined;
  const id = DRIVE_LINK_FORMAT.exec(value)?.[1];
  return id === undefined ? undefined : canonicalDriveLink(id);
}

// The link to the file a write just returned. Drive's webViewLink is not
// usable for every type — a text/markdown file does not come back as
// /file/d/<id>/view — so the saved link is built from the validated file id.
export function driveLinkForId(id: unknown): DriveLink | undefined {
  return typeof id === 'string' ? canonicalDriveLink(id) : undefined;
}

export class DriveError extends Error {
  readonly status?: number;
  // Google's machine reason identifier (Drive error.errors[0].reason, or the
  // OAuth token endpoint's error code). Free text is never kept here.
  readonly reason?: string;

  constructor(message: string, status?: number, reason?: string) {
    super(message);
    this.name = 'DriveError';
    this.status = status;
    this.reason = reason;
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

function parseServiceAccount(parsed: unknown, source: string): ServiceAccount {
  const doc = typeof parsed === 'object' && parsed !== null ? parsed : {};
  const email = field(doc, 'client_email');
  const key = field(doc, 'private_key');
  if (typeof email !== 'string' || typeof key !== 'string') {
    throw new TranscriptError(
      'invalid_config',
      `${source}: not a service account key (needs client_email and private_key)`,
    );
  }
  return { client_email: email, private_key: key };
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
  return parseServiceAccount(parsed, credentialsPath);
}

function loadServiceAccountJson(json: string): ServiceAccount {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new TranscriptError('invalid_config', 'GOOGLE_CREDENTIALS_JSON is not valid JSON');
  }
  return parseServiceAccount(parsed, 'GOOGLE_CREDENTIALS_JSON');
}

interface OAuthClient {
  client_id: string;
  client_secret: string;
  refresh_token: string;
}

// An OAuth refresh token of a human Drive user. A service account owns no
// storage, so on a consumer My Drive only a user's own token can create files.
function loadOAuthJson(json: string): OAuthClient {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new TranscriptError('invalid_config', 'GOOGLE_OAUTH_JSON is not valid JSON');
  }
  const id = field(parsed, 'client_id');
  const secret = field(parsed, 'client_secret');
  const refresh = field(parsed, 'refresh_token');
  if (
    typeof id !== 'string' || id === '' ||
    typeof secret !== 'string' || secret === '' ||
    typeof refresh !== 'string' || refresh === ''
  ) {
    throw new TranscriptError(
      'invalid_config',
      'GOOGLE_OAUTH_JSON: needs client_id, client_secret and refresh_token',
    );
  }
  return { client_id: id, client_secret: secret, refresh_token: refresh };
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
const FILE_FIELDS = 'id,name';
const UPLOAD_BOUNDARY = 'fa_transcript_boundary';

function storedFile(file: unknown): StoredFile {
  const id = field(file, 'id');
  const name = field(file, 'name');
  return {
    id: typeof id === 'string' ? id : '',
    name: typeof name === 'string' ? name : '',
  };
}

// Drive v3 multipart upload: the metadata as application/json first, then the
// media part.
function uploadBody(
  metadata: Record<string, unknown>,
  content: string,
  mimeType: string,
): string {
  return [
    `--${UPLOAD_BOUNDARY}`,
    'content-type: application/json; charset=UTF-8',
    '',
    JSON.stringify(metadata),
    `--${UPLOAD_BOUNDARY}`,
    `content-type: ${mimeType}`,
    '',
    content,
    `--${UPLOAD_BOUNDARY}--`,
    '',
  ].join('\r\n');
}

const REASON_FORMAT = /^[A-Za-z_]{1,64}$/;

// Drive answers {error:{errors:[{reason}]}}; the token endpoint answers
// {error:"invalid_grant"}. Only an identifier-shaped value is kept.
async function readReason(res: Response): Promise<string | undefined> {
  let body: unknown;
  try {
    body = JSON.parse(await res.text());
  } catch {
    return undefined;
  }
  const errors = field(field(body, 'error'), 'errors');
  const driveReason = Array.isArray(errors) ? field(errors[0], 'reason') : undefined;
  const oauthReason = field(body, 'error');
  return [driveReason, oauthReason].find(
    (v): v is string => typeof v === 'string' && REASON_FORMAT.test(v),
  );
}

async function readApiError(res: Response, oauth = false): Promise<DriveError> {
  const shareHint =
    res.status === 403 && !oauth ? ' — is the folder shared with the service account email?' : '';
  const reason = await readReason(res);
  return new DriveError(`Drive API error ${res.status}${shareHint}`, res.status, reason);
}

export interface DriveStoreOptions {
  credentialsPath?: string;
  // The key JSON inline (from a secrets-manager env var) instead of a
  // mounted file. credentialsPath wins when both are set.
  credentialsJson?: string;
  // An OAuth client plus refresh token as JSON {client_id, client_secret,
  // refresh_token}. Used only when no service-account credentials are set.
  oauthJson?: string;
  fetchImpl?: typeof fetch;
}

// Service-account mode: the tenant shares its Drive folder with the service
// account email and drive.file scope reaches exactly that folder; it works
// only in a shared drive (Workspace), because a service account has no quota.
// OAuth mode: the refresh token of a user acts as that user, so files land in
// the user's own My Drive; the scope is whatever the user consented to.
export function createDriveStore(options: DriveStoreOptions): DriveStore {
  const doFetch = options.fetchImpl ?? fetch;
  let account: ServiceAccount | undefined;
  let token: { value: string; expiresAt: number } | undefined;

  const serviceAccount = (): ServiceAccount => {
    if (account) return account;
    if (options.credentialsPath !== undefined) {
      account = loadServiceAccount(options.credentialsPath);
    } else if (options.credentialsJson !== undefined) {
      account = loadServiceAccountJson(options.credentialsJson);
    } else {
      throw new TranscriptError('invalid_config', 'no Google service account credentials configured');
    }
    return account;
  };

  const useOAuth =
    options.credentialsPath === undefined &&
    options.credentialsJson === undefined &&
    options.oauthJson !== undefined;
  let oauth: OAuthClient | undefined;

  async function accessToken(): Promise<string> {
    if (token && Date.now() < token.expiresAt - 60_000) return token.value;
    let form: URLSearchParams;
    if (useOAuth) {
      oauth ??= loadOAuthJson(options.oauthJson ?? '');
      form = new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: oauth.client_id,
        client_secret: oauth.client_secret,
        refresh_token: oauth.refresh_token,
      });
    } else {
      form = new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: signJwt(serviceAccount(), DRIVE_SCOPE),
      });
    }
    const res = await doFetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    });
    if (!res.ok) throw await readApiError(res, useOAuth);
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
    if (!res.ok) throw await readApiError(res, useOAuth);
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
    return found === undefined ? null : storedFile(found);
  }

  return {
    // The repeat-video lookup: the video id rides on the file's
    // appProperties, so a new title or a new capture day still lands on the
    // same file.
    async findFileByVideoId(folderId, videoId) {
      return search(
        `appProperties has {key='videoId' and value='${escape(videoId)}'} and '${escape(folderId)}' in parents and trashed=false`,
      );
    },

    async createFile(folderId, name, content, mimeType, appProperties) {
      const res = await api(
        `${DRIVE_UPLOAD}/files?uploadType=multipart&supportsAllDrives=true&fields=${encodeURIComponent(FILE_FIELDS)}`,
        {
          method: 'POST',
          headers: { 'content-type': `multipart/related; boundary=${UPLOAD_BOUNDARY}` },
          body: uploadBody(
            {
              name,
              mimeType,
              parents: [folderId],
              ...(appProperties === undefined ? {} : { appProperties }),
            },
            content,
            mimeType,
          ),
        },
      );
      return storedFile(await res.json());
    },

    // Parents and appProperties are sent only when they change, so this PATCH
    // keeps the file where it is and still finds it by video id next time.
    async updateFile(fileId, name, content, mimeType) {
      const res = await api(
        `${DRIVE_UPLOAD}/files/${encodeURIComponent(fileId)}?uploadType=multipart&supportsAllDrives=true&fields=${encodeURIComponent(FILE_FIELDS)}`,
        {
          method: 'PATCH',
          headers: { 'content-type': `multipart/related; boundary=${UPLOAD_BOUNDARY}` },
          body: uploadBody({ name, mimeType }, content, mimeType),
        },
      );
      return storedFile(await res.json());
    },
  };
}
