import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createVerify, generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDriveStore, driveLinkForId, DriveError, parseDriveLink } from '../src/drive.js';
import { TranscriptError } from '../src/errors.js';

// The key pair is generated at test time: no key material ever sits in a
// tracked file.
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PUBLIC_PEM = publicKey.export({ type: 'pkcs1', format: 'pem' });
const PRIVATE_PEM = privateKey.export({ type: 'pkcs8', format: 'pem' });
const SA_EMAIL = 'sa@example.invalid';

function credentialsFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'fa-drive-creds-'));
  const file = join(dir, 'service-account.json');
  writeFileSync(file, JSON.stringify({ client_email: SA_EMAIL, private_key: PRIVATE_PEM }));
  return file;
}

interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

function fakeFetch(routes: (req: CapturedRequest) => Response) {
  const requests: CapturedRequest[] = [];
  const impl = (async (input: unknown, init?: RequestInit) => {
    const req: CapturedRequest = {
      url: String(input),
      method: init?.method ?? 'GET',
      headers: Object.fromEntries(
        Object.entries(init?.headers ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)]),
      ),
      body: typeof init?.body === 'string' ? init.body : undefined,
    };
    requests.push(req);
    return routes(req);
  }) as typeof fetch;
  return { impl, requests };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const TOKEN_ROUTE = (req: CapturedRequest) => {
  assert.equal(req.url, 'https://oauth2.googleapis.com/token');
  assert.equal(req.method, 'POST');
  const params = new URLSearchParams(req.body);
  assert.equal(params.get('grant_type'), 'urn:ietf:params:oauth:grant-type:jwt-bearer');
  const assertion = params.get('assertion') ?? '';
  const [header, claims, signature] = assertion.split('.');
  assert.ok(header && claims && signature, 'JWT must have three parts');
  const verifier = createVerify('RSA-SHA256');
  verifier.update(`${header}.${claims}`);
  assert.ok(verifier.verify(PUBLIC_PEM, signature, 'base64url'), 'JWT signature must verify');
  const payload = JSON.parse(Buffer.from(claims, 'base64url').toString('utf8'));
  assert.equal(payload.iss, SA_EMAIL);
  assert.equal(payload.scope, 'https://www.googleapis.com/auth/drive.file');
  assert.equal(payload.aud, 'https://oauth2.googleapis.com/token');
  return json({ access_token: 'tok-1', expires_in: 3600 });
};

test('findFileByVideoId miss then createFile: token exchange, query, multipart create', async () => {
  const { impl, requests } = fakeFetch((req) => {
    if (req.url.startsWith('https://oauth2.googleapis.com/token')) return TOKEN_ROUTE(req);
    if (req.url.startsWith('https://www.googleapis.com/drive/v3/files')) {
      const q = new URL(req.url).searchParams.get('q') ?? '';
      assert.match(q, /appProperties has \{key='videoId' and value='hWe-j78vNpc'\}/);
      assert.match(q, /'folder-1' in parents/);
      assert.match(q, /trashed=false/);
      return json({ files: [] });
    }
    if (req.url.startsWith('https://www.googleapis.com/upload/drive/v3/files')) {
      assert.equal(req.method, 'POST');
      assert.match(req.url, /uploadType=multipart/);
      assert.match(req.headers['content-type'], /^multipart\/related; boundary=/);
      assert.match(req.body ?? '', /"parents":\["folder-1"\]/);
      assert.match(req.body ?? '', /"name":"clip_20261122\.txt"/);
      assert.match(req.body ?? '', /"appProperties":\{"videoId":"hWe-j78vNpc"\}/);
      assert.match(req.body ?? '', /file contents here/);
      assert.equal(req.headers.authorization, 'Bearer tok-1');
      return json({
        id: 'drv-1',
        name: 'clip_20261122.txt',
        webViewLink: 'https://drive.google.com/file/d/drv-1/view',
      });
    }
    throw new Error(`unexpected request ${req.method} ${req.url}`);
  });
  const drive = createDriveStore({ credentialsPath: credentialsFile(), fetchImpl: impl });

  assert.equal(await drive.findFileByVideoId('folder-1', 'hWe-j78vNpc'), null);
  const stored = await drive.createFile(
    'folder-1',
    'clip_20261122.txt',
    'file contents here',
    'text/plain',
    { videoId: 'hWe-j78vNpc' },
  );
  assert.equal(stored.id, 'drv-1');
  assert.equal(stored.name, 'clip_20261122.txt');

  // Token fetched once, then cached.
  assert.equal(requests.filter((r) => r.url.includes('oauth2')).length, 1);
  assert.equal(requests.filter((r) => r.headers.authorization === 'Bearer tok-1').length, 2);
});

test('findFileByVideoId queries the stored appProperties video id inside the folder', async () => {
  const { impl } = fakeFetch((req) => {
    if (req.url.startsWith('https://oauth2.googleapis.com/token')) return TOKEN_ROUTE(req);
    if (req.url.startsWith('https://www.googleapis.com/drive/v3/files')) {
      const q = new URL(req.url).searchParams.get('q') ?? '';
      assert.match(q, /appProperties has \{key='videoId' and value='hWe-j78vNpc'\}/);
      assert.match(q, /'folder-1' in parents/);
      assert.match(q, /trashed=false/);
      return json({
        files: [{ id: 'drv-7', name: 'clip_hWe-j78vNpc_20261122.txt', webViewLink: 'https://x/drv-7' }],
      });
    }
    throw new Error(`unexpected request ${req.method} ${req.url}`);
  });
  const drive = createDriveStore({ credentialsPath: credentialsFile(), fetchImpl: impl });

  const found = await drive.findFileByVideoId('folder-1', 'hWe-j78vNpc');
  assert.equal(found?.id, 'drv-7');
});

test('findFileByVideoId hit then updateFile renames and rewrites the same file id', async () => {
  const { impl, requests } = fakeFetch((req) => {
    if (req.url.startsWith('https://oauth2.googleapis.com/token')) return TOKEN_ROUTE(req);
    if (req.url.startsWith('https://www.googleapis.com/drive/v3/files')) {
      return json({
        files: [{ id: 'drv-9', name: 'clip_20261122.txt', webViewLink: 'https://x/drv-9' }],
      });
    }
    if (req.url.startsWith('https://www.googleapis.com/upload/drive/v3/files/drv-9')) {
      assert.equal(req.method, 'PATCH');
      assert.match(req.url, /uploadType=multipart/);
      assert.match(req.headers['content-type'], /^multipart\/related; boundary=/);
      assert.match(req.body ?? '', /"name":"clip_20261122\.md"/);
      assert.match(req.body ?? '', /"mimeType":"text\/markdown"/);
      assert.match(req.body ?? '', /\r\n--fa_transcript_boundary\r\ncontent-type: text\/markdown\r\n\r\n# new contents\n/);
      // A rename must not move the file or drop its video id.
      assert.doesNotMatch(req.body ?? '', /"parents"/);
      assert.doesNotMatch(req.body ?? '', /"appProperties"/);
      return json({ id: 'drv-9', name: 'clip_20261122.md' });
    }
    throw new Error(`unexpected request ${req.method} ${req.url}`);
  });
  const drive = createDriveStore({ credentialsPath: credentialsFile(), fetchImpl: impl });

  const found = await drive.findFileByVideoId('folder-1', 'hWe-j78vNpc');
  assert.equal(found?.id, 'drv-9');
  const updated = await drive.updateFile('drv-9', 'clip_20261122.md', '# new contents\n', 'text/markdown');
  assert.deepEqual(updated, { id: 'drv-9', name: 'clip_20261122.md' });
  assert.equal(requests.some((r) => r.method === 'POST' && r.url.includes('upload')), false);
});

// The live failure (#1534): Drive answers a text/markdown create with a
// webViewLink that is not /file/d/<id>/view, so parsing that link rejected a
// write that had succeeded. The saved link is built from the file id instead.
test('a text/markdown create whose webViewLink is not a file/d link still yields the id link', async () => {
  const { impl } = fakeFetch((req) => {
    if (req.url.startsWith('https://oauth2.googleapis.com/token')) return TOKEN_ROUTE(req);
    return json({
      id: 'drv-md',
      name: 'rick-astley-never-gonna-give-you-up_dQw4w9WgXcQ_20261124.md',
      webViewLink: 'https://drive.google.com/open?id=drv-md&usp=drivesdk',
    });
  });
  const drive = createDriveStore({ credentialsPath: credentialsFile(), fetchImpl: impl });
  const stored = await drive.createFile(
    'folder-1',
    'rick-astley_dQw4w9WgXcQ_20261124.md',
    '# Title\n',
    'text/markdown',
    { videoId: 'dQw4w9WgXcQ' },
  );
  assert.equal(parseDriveLink('https://drive.google.com/open?id=drv-md&usp=drivesdk'), undefined);
  assert.equal(driveLinkForId(stored.id), 'https://drive.google.com/file/d/drv-md/view');
});

test('a 403 from the API becomes a DriveError with the folder-sharing hint', async () => {
  const { impl } = fakeFetch((req) => {
    if (req.url.startsWith('https://oauth2.googleapis.com/token')) return TOKEN_ROUTE(req);
    return json({ error: { message: 'insufficient permissions' } }, 403);
  });
  const drive = createDriveStore({ credentialsPath: credentialsFile(), fetchImpl: impl });
  const err = await drive.findFileByVideoId('folder-1', 'hWe-j78vNpc').then(
    () => assert.fail('should throw'),
    (e: unknown) => e,
  );
  assert.ok(err instanceof DriveError);
  assert.equal(err.status, 403);
  assert.match(err.message, /403/);
  assert.match(err.message, /shared with the service account/);
});

test('a missing or malformed credentials file is invalid_config', async () => {
  const { impl } = fakeFetch(() => json({}));
  const drive = createDriveStore({ credentialsPath: '/nonexistent/sa.json', fetchImpl: impl });
  await assert.rejects(() => drive.findFileByVideoId('f', 'n'), TranscriptError);

  const dir = mkdtempSync(join(tmpdir(), 'fa-drive-creds-'));
  const bad = join(dir, 'bad.json');
  writeFileSync(bad, JSON.stringify({ type: 'service_account' }));
  const drive2 = createDriveStore({ credentialsPath: bad, fetchImpl: impl });
  await assert.rejects(() => drive2.findFileByVideoId('f', 'n'), /client_email/);
});

const OAUTH_JSON = JSON.stringify({
  client_id: 'cid.invalid',
  client_secret: 'csecret',
  refresh_token: 'rtoken',
});

test('OAuth mode: exchanges the refresh token, then uploads into the folder as that user', async () => {
  const { impl, requests } = fakeFetch((req) => {
    if (req.url === 'https://oauth2.googleapis.com/token') {
      const params = new URLSearchParams(req.body);
      assert.equal(params.get('grant_type'), 'refresh_token');
      assert.equal(params.get('client_id'), 'cid.invalid');
      assert.equal(params.get('client_secret'), 'csecret');
      assert.equal(params.get('refresh_token'), 'rtoken');
      return json({ access_token: 'tok-oauth', expires_in: 3600 });
    }
    assert.equal(req.headers.authorization, 'Bearer tok-oauth');
    return json({ id: 'f1', name: 'a.md', webViewLink: 'https://drive.google.com/file/d/f1/view' });
  });
  const drive = createDriveStore({ oauthJson: OAUTH_JSON, fetchImpl: impl });
  const file = await drive.createFile('folder-1', 'a.md', 'x', 'text/markdown');
  assert.equal(file.id, 'f1');
  const upload = requests.find((r) => r.url.startsWith('https://www.googleapis.com/upload/drive/v3/files'));
  assert.ok(upload, 'file uploaded');
  assert.match(upload.body ?? '', /"parents":\["folder-1"\]/);
});

// Reproduces the Markdown create (#1529): metadata first as application/json,
// the stored type named in the metadata, and the media part typed text/markdown.
// Shape per Drive v3 multipart upload: developers.google.com/workspace/drive/api/guides/manage-uploads
test('Markdown create: metadata names text/markdown and the media part is text/markdown', async () => {
  const { impl, requests } = fakeFetch((req) => {
    if (req.url.startsWith('https://oauth2.googleapis.com/token')) return TOKEN_ROUTE(req);
    return json({ id: 'drv-md', name: 'clip_20261124.md', webViewLink: 'https://drive.google.com/file/d/drv-md/view' });
  });
  const drive = createDriveStore({ credentialsPath: credentialsFile(), fetchImpl: impl });
  await drive.createFile('folder-1', 'clip_20261124.md', '# Title\n\n**[0:01]** hello', 'text/markdown', {
    videoId: 'hWe-j78vNpc',
  });
  const body = requests.find((r) => r.url.includes('/upload/drive/v3/files'))?.body ?? '';
  assert.match(body, /^--fa_transcript_boundary\r\ncontent-type: application\/json; charset=UTF-8\r\n\r\n\{/);
  assert.match(body, /"mimeType":"text\/markdown"/);
  assert.match(body, /"name":"clip_20261124\.md"/);
  assert.match(body, /\r\n--fa_transcript_boundary\r\ncontent-type: text\/markdown\r\n\r\n# Title\n/);
  assert.match(body, /--fa_transcript_boundary--\r\n$/);
});

// The reason is an identifier Google names in its error body; the message text
// and the OAuth error_description never travel with it.
test('an API error keeps only Google\'s reason identifier, from Drive and from the token endpoint', async () => {
  const drive403 = fakeFetch((req) => {
    if (req.url.startsWith('https://oauth2.googleapis.com/token')) return TOKEN_ROUTE(req);
    return json(
      {
        error: {
          code: 403,
          message: 'The user does not have sufficient permissions for this file.',
          errors: [{ domain: 'global', reason: 'insufficientFilePermissions', message: 'secret text' }],
        },
      },
      403,
    );
  });
  const d1 = createDriveStore({ credentialsPath: credentialsFile(), fetchImpl: drive403.impl });
  const e1 = await d1.findFileByVideoId('folder-1', 'hWe-j78vNpc').then(
    () => assert.fail('should throw'),
    (e: unknown) => e,
  );
  assert.ok(e1 instanceof DriveError);
  assert.equal(e1.status, 403);
  assert.equal(e1.reason, 'insufficientFilePermissions');

  const tokenFail = fakeFetch(() =>
    json({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }, 400),
  );
  const d2 = createDriveStore({ oauthJson: OAUTH_JSON, fetchImpl: tokenFail.impl });
  const e2 = await d2.findFileByVideoId('folder-1', 'hWe-j78vNpc').then(
    () => assert.fail('should throw'),
    (e: unknown) => e,
  );
  assert.ok(e2 instanceof DriveError);
  assert.equal(e2.status, 400);
  assert.equal(e2.reason, 'invalid_grant');
  assert.doesNotMatch(e2.message, /expired or revoked/);
});
