import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createService } from '../src/service.js';
import type { GeminiCaller } from '../src/gemini.js';
import {
  createWebdavStore,
  nameMatchesVideoId,
  parseWebdavBaseUrl,
  parseWebdavFolder,
  webdavPath,
  WebdavError,
} from '../src/webdav.js';
import { createTranscriptSaver, SaveFailedError } from '../src/save.js';
import { loadTenantsFile, type JobOrigin } from '../src/tenants.js';
import { TranscriptError } from '../src/errors.js';
import { createApiClient, type SavedLink } from '../src/bot/api.js';
import { createBot, type AttachmentFile } from '../src/bot/core.js';
import { deriveEncryptionKey } from '../src/bot/crypto.js';
import { GuildStore } from '../src/bot/store.js';

const GOOD = readFileSync(new URL('./fixtures/model-good.txt', import.meta.url), 'utf8');
const VIDEO_A = 'hWe-j78vNpc';
const VIDEO_B = 'dQw4w9WgXcQ';
const KEY = 'TEST-KEY-NAS-k7k7k7';
const FIXED_NOW = new Date('2026-11-22T03:00:00Z');
const META = { title: 'My Great Video!', channel: 'Test Channel' };
const GUILD = 'guild-n';
const CHANNEL = 'chan-1';
const THREAD = 'thread-1';

const NAS_USER = 'nas-user';
const NAS_PASSWORD = 's3cret-nas-password';
const NAS_BASE = 'https://nas.test';
const NAS_ENV = 'FA_TEST_NAS_PASSWORD';
const NAS_TOKEN = 'test-caller-token-nas';

const sha256 = (token: string): string => createHash('sha256').update(token).digest('hex');

const NAS_TENANTS = [
  {
    id: 'nas-room',
    discord_guild_id: GUILD,
    caller: { token_sha256: sha256(NAS_TOKEN) },
    destination: {
      type: 'webdav',
      base_url: NAS_BASE,
      path: '/transcripts',
      username: NAS_USER,
      password_env: NAS_ENV,
      extension: '.md',
    },
  },
];

// --- local WebDAV test server ------------------------------------------------
// A real HTTP server on 127.0.0.1 that speaks just enough WebDAV: PROPFIND
// lists direct children, MKCOL creates a collection only when its parent
// exists, PUT stores the body. The injected fetch maps the configured
// https:// base onto it, so no plain-HTTP config is ever exercised.

interface FakeNas {
  port: number;
  files: Map<string, string>;
  dirs: Set<string>;
  requests: string[];
  close: () => Promise<void>;
}

function parentDir(path: string): string {
  const i = path.lastIndexOf('/');
  return i <= 0 ? '/' : path.slice(0, i);
}

async function startNas(dirs: string[] = []): Promise<FakeNas> {
  const dirSet = new Set<string>(['/', ...dirs]);
  const files = new Map<string, string>();
  const requests: string[] = [];
  const server = createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url ?? '/', 'http://nas.local').pathname);
    requests.push(`${req.method} ${path}`);
    const expected = `Basic ${Buffer.from(`${NAS_USER}:${NAS_PASSWORD}`).toString('base64')}`;
    if (req.headers.authorization !== expected) {
      // Upstream text a failure must never carry to a log or a reply.
      res.writeHead(401, { 'content-type': 'text/plain' });
      res.end('upstream-rejection-marker-99');
      return;
    }
    if (req.method === 'PROPFIND') {
      if (!dirSet.has(path)) {
        res.writeHead(404);
        res.end();
        return;
      }
      const children = [...files.keys()].filter((f) => parentDir(f) === path);
      const hrefs = [`${path === '/' ? '/' : `${path}/`}`, ...children]
        .map((p) => `<D:response><D:href>${encodeURI(p)}</D:href></D:response>`)
        .join('');
      res.writeHead(207, { 'content-type': 'application/xml' });
      res.end(`<?xml version="1.0"?><D:multistatus xmlns:D="DAV:">${hrefs}</D:multistatus>`);
      return;
    }
    if (req.method === 'MKCOL') {
      if (dirSet.has(path)) {
        res.writeHead(405);
        res.end();
        return;
      }
      if (!dirSet.has(parentDir(path))) {
        res.writeHead(409);
        res.end();
        return;
      }
      dirSet.add(path);
      res.writeHead(201);
      res.end();
      return;
    }
    if (req.method === 'PUT') {
      if (!dirSet.has(parentDir(path))) {
        res.writeHead(409);
        res.end();
        return;
      }
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        files.set(path, Buffer.concat(chunks).toString('utf8'));
        res.writeHead(201);
        res.end();
      });
      return;
    }
    res.writeHead(501);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    port,
    files,
    dirs: dirSet,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function nasFetch(port: number): typeof fetch {
  return ((input: unknown, init?: RequestInit) =>
    fetch(String(input).replace(NAS_BASE, `http://127.0.0.1:${port}`), init)) as typeof fetch;
}

// --- service harness ---------------------------------------------------------

interface RunningService {
  base: string;
  dir: string;
  tenantsFile: string;
  logs: string[];
  close: () => Promise<void>;
}

function writeTenantsFile(dir: string, tenants: unknown): string {
  const file = join(dir, 'tenants.json');
  writeFileSync(file, JSON.stringify({ tenants }, null, 2));
  return file;
}

async function startService(
  nas: FakeNas,
  tenants: unknown,
  opts: { now?: () => Date; metadata?: () => Promise<typeof META> } = {},
): Promise<RunningService> {
  const dir = mkdtempSync(join(tmpdir(), 'fa-nas-'));
  const tenantsFile = writeTenantsFile(dir, tenants);
  const logs: string[] = [];
  const caller: GeminiCaller = async (req) => ({
    text: (req.startOffsetSeconds ?? 0) > 0 ? 'LANGUAGE: en' : GOOD,
    status: 'completed',
  });
  const server: Server = createService({
    callerFactory: () => caller,
    model: 'test-model',
    maxBlockSeconds: 8,
    cacheDir: mkdtempSync(join(tmpdir(), 'fa-nas-cache-')),
    tenantsFile,
    webdavFetch: nasFetch(nas.port),
    videoMetadata: opts.metadata ?? (async () => META),
    now: opts.now ?? (() => FIXED_NOW),
    log: (line) => logs.push(line),
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    dir,
    tenantsFile,
    logs,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

interface HttpResult {
  status: number;
  body: any;
}

async function submitJob(
  base: string,
  opts: { url?: string; origin?: unknown; token?: string } = {},
): Promise<HttpResult> {
  const headers: Record<string, string> = { 'content-type': 'application/json', 'x-gemini-key': KEY };
  if (opts.token !== undefined) headers['authorization'] = `Bearer ${opts.token}`;
  const res = await fetch(`${base}/v1/jobs`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      url: opts.url ?? `https://youtu.be/${VIDEO_A}`,
      ...(opts.origin !== undefined ? { origin: opts.origin } : {}),
    }),
  });
  return { status: res.status, body: await res.json() };
}

async function pollJob(base: string, id: string): Promise<any> {
  for (let i = 0; i < 500; i++) {
    const res = await fetch(`${base}/v1/jobs/${id}`);
    const body = await res.json();
    assert.equal(res.status, 200);
    if (body.status === 'done' || body.status === 'failed') return body;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.fail('job did not finish in time');
}

function discordOrigin(guildId: string, channelId: string): JobOrigin {
  return { kind: 'discord', guild_id: guildId, channel_id: channelId };
}

function withNasPassword(fn: () => Promise<void>): () => Promise<void> {
  return async () => {
    process.env[NAS_ENV] = NAS_PASSWORD;
    try {
      await fn();
    } finally {
      delete process.env[NAS_ENV];
    }
  };
}

async function botReplyFor(
  svc: RunningService,
  url: string,
): Promise<{ content: string; files: AttachmentFile[]; link?: SavedLink }[]> {
  const dir = mkdtempSync(join(tmpdir(), 'fa-nas-bot-'));
  const store = new GuildStore(join(dir, 'bot-data.json'), deriveEncryptionKey('test-secret'));
  store.setKey(GUILD, KEY);
  store.enableChannel(GUILD, CHANNEL);
  const api = createApiClient({
    baseUrl: svc.base,
    serviceToken: NAS_TOKEN,
    pollIntervalMs: 5,
    timeoutMs: 10_000,
  });
  const core = createBot({ api, store });
  const replies: { content: string; files: AttachmentFile[]; link?: SavedLink }[] = [];
  await core.handleMessage(
    {
      guildId: GUILD,
      channelId: THREAD,
      parentChannelId: CHANNEL,
      authorIsBot: false,
      content: `check this ${url}`,
    },
    {
      react: async () => {},
      reply: async (content, files, link) => {
        replies.push({ content, files, link });
      },
    },
  );
  return replies;
}

// --- G1: save to NAS ---------------------------------------------------------

test(
  'G1: a Discord job for a webdav tenant writes the file under the configured path and the reply shows it',
  withNasPassword(async () => {
    const nas = await startNas(); // /transcripts does not exist yet
    const svc = await startService(nas, NAS_TENANTS);
    try {
      const res = await submitJob(svc.base, { origin: discordOrigin(GUILD, CHANNEL), token: NAS_TOKEN });
      const job = await pollJob(svc.base, res.body.job_id);
      assert.equal(job.status, 'done');
      assert.equal(job.saved.type, 'webdav');
      const expected = `/transcripts/my-great-video_${VIDEO_A}_20261122.md`;
      assert.equal(job.saved.path, expected);
      assert.match(nas.files.get(expected) ?? '', /^Title: My Great Video!/);
      // The folder was missing: exactly one MKCOL, on the configured path.
      assert.deepEqual(
        nas.requests.filter((r) => r.startsWith('MKCOL')),
        ['MKCOL /transcripts'],
      );
      // G5: the file and every log line stay free of the password.
      const tenantsJson = readFileSync(svc.tenantsFile, 'utf8');
      assert.match(tenantsJson, /FA_TEST_NAS_PASSWORD/);
      assert.ok(!tenantsJson.includes(NAS_PASSWORD), 'the tenants file holds the env name only');
      assert.ok(!svc.logs.join('\n').includes(NAS_PASSWORD), 'no password in any log line');
      assert.ok(!JSON.stringify(job).includes(NAS_PASSWORD), 'no password in the job view');

      const replies = await botReplyFor(svc, `https://youtu.be/${VIDEO_B}`);
      assert.equal(replies.length, 1);
      assert.equal(replies[0].link?.type, 'webdav');
      if (replies[0].link?.type === 'webdav') {
        assert.equal(replies[0].link.path, `/transcripts/my-great-video_${VIDEO_B}_20261122.md`);
      }
      assert.ok(nas.files.has(`/transcripts/my-great-video_${VIDEO_B}_20261122.md`));
      assert.ok(!replies[0].content.includes(NAS_PASSWORD));
    } finally {
      await svc.close();
      await nas.close();
    }
  }),
);

// --- G2: path confinement ----------------------------------------------------

test(
  'G2: file names that would escape the configured folder are refused before any request',
  withNasPassword(async () => {
    const nas = await startNas(['/transcripts']);
    const base = parseWebdavBaseUrl(NAS_BASE);
    assert.ok(base);
    const store = createWebdavStore({
      baseUrl: base,
      path: '/transcripts',
      username: NAS_USER,
      password: NAS_PASSWORD,
      fetchImpl: nasFetch(nas.port),
    });
    for (const bad of [
      '../escape.txt',
      'a/b.txt',
      'a\\b.txt',
      'a%2Fb.txt',
      '%2e%2e',
      '..',
      '.',
      'x/y/../z.txt',
    ]) {
      await assert.rejects(() => store.createFile(bad, 'x', 'text/plain'), WebdavError);
    }
    for (const bad of [
      '/outside/x.txt',
      '/transcripts/../escape.txt',
      'transcripts/x.txt',
      '/transcripts',
      '/transcripts/..%2Fevil.txt',
    ]) {
      await assert.rejects(() => store.updateFile(bad, 'x', 'text/plain'), WebdavError);
    }
    assert.equal(nas.requests.length, 0, 'a rejected name never reaches the wire');
    const ok = await store.createFile('fine_name_20261122.txt', 'body', 'text/plain');
    assert.equal(ok.path, '/transcripts/fine_name_20261122.txt');
    assert.equal(nas.files.get('/transcripts/fine_name_20261122.txt'), 'body');
    await nas.close();
  }),
);

test('G2: hrefs in a listing that decode outside the folder are ignored', async () => {
  const base = parseWebdavBaseUrl(NAS_BASE);
  assert.ok(base);
  const xml = `<?xml version="1.0"?><D:multistatus xmlns:D="DAV:">` +
    `<D:response><D:href>/transcripts/</D:href></D:response>` +
    `<D:response><D:href>/transcripts/..%2Fevil_${VIDEO_A}_20261122.txt</D:href></D:response>` +
    `<D:response><D:href>/other/victim_${VIDEO_A}_20261122.txt</D:href></D:response>` +
    `<D:response><D:href>https://nas.test/transcripts/real_${VIDEO_A}_20261122.txt</D:href></D:response>` +
    `</D:multistatus>`;
  const impl = (async () => new Response(xml, { status: 207 })) as typeof fetch;
  const store = createWebdavStore({
    baseUrl: base,
    path: '/transcripts',
    username: 'u',
    password: 'p',
    fetchImpl: impl,
  });
  const found = await store.findFileByVideoId(VIDEO_A);
  assert.equal(found?.id, `/transcripts/real_${VIDEO_A}_20261122.txt`);
});

test(
  'G2: a hostile video id in a transcript cannot write outside the folder',
  withNasPassword(async () => {
    const nas = await startNas(['/transcripts']);
    const dir = mkdtempSync(join(tmpdir(), 'fa-nas-'));
    const tenantsFile = writeTenantsFile(dir, [
      {
        id: 'nas-room',
        discord_guild_id: GUILD,
        destination: {
          type: 'webdav',
          base_url: NAS_BASE,
          path: '/transcripts',
          username: NAS_USER,
          password_env: NAS_ENV,
        },
      },
    ]);
    const save = createTranscriptSaver({
      tenantsFile,
      webdavFetch: nasFetch(nas.port),
      metadata: async () => ({ title: 'x' }),
      now: () => FIXED_NOW,
    });
    const origin = discordOrigin(GUILD, CHANNEL);
    for (const videoId of ['..%2F..%2Fetc', 'a/b', '..\\..\\x', 'x%2Fy', 'a%0Ab']) {
      await assert.rejects(
        () =>
          save(origin, {
            video_id: videoId,
            source_url: `https://www.youtube.com/watch?v=${videoId}`,
            language: 'en',
            blocks: [{ start: 0, end: 1, text: 'hi' }],
          }),
        SaveFailedError,
      );
    }
    assert.equal(nas.files.size, 0, 'nothing was written anywhere');
    assert.ok(
      nas.requests.every((r) => r.startsWith('PROPFIND') || r.startsWith('MKCOL') || r.startsWith('PUT /transcripts/')),
      `confined requests: ${nas.requests.join(', ')}`,
    );
    await nas.close();
  }),
);

test('G2: configured paths with traversal or backslash are refused at config load', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fa-nas-'));
  const file = join(dir, 'tenants.json');
  for (const bad of ['/a/../b', '/a\\b', '/.', '/..', 'a//../b']) {
    writeFileSync(
      file,
      JSON.stringify({
        tenants: [
          {
            id: 'x',
            destination: {
              type: 'webdav',
              base_url: NAS_BASE,
              path: bad,
              username: 'u',
              password_env: 'E',
            },
          },
        ],
      }),
    );
    assert.throws(() => loadTenantsFile(file), TranscriptError, `path ${bad}`);
  }
});

// --- G3: file identity --------------------------------------------------------

test(
  'G3: the same video updates one file in place; two videos with the same title keep two files',
  withNasPassword(async () => {
    const nas = await startNas(['/transcripts']);
    const svc = await startService(nas, NAS_TENANTS, {
      metadata: async () => ({ title: 'Same title' }),
    });
    try {
      for (let i = 0; i < 2; i++) {
        const res = await submitJob(svc.base, { origin: discordOrigin(GUILD, CHANNEL), token: NAS_TOKEN });
        const job = await pollJob(svc.base, res.body.job_id);
        assert.equal(job.status, 'done');
        assert.equal(job.saved.path, `/transcripts/same-title_${VIDEO_A}_20261122.md`);
      }
      const onlyA = `/transcripts/same-title_${VIDEO_A}_20261122.md`;
      assert.ok(nas.files.has(onlyA));
      assert.equal(nas.files.size, 1, 'same video twice is one file, updated in place');

      const resB = await submitJob(svc.base, {
        url: `https://youtu.be/${VIDEO_B}`,
        origin: discordOrigin(GUILD, CHANNEL),
        token: NAS_TOKEN,
      });
      const jobB = await pollJob(svc.base, resB.body.job_id);
      assert.equal(jobB.saved.path, `/transcripts/same-title_${VIDEO_B}_20261122.md`);
      assert.equal(nas.files.size, 2, 'a second video with the same title is a second file');
    } finally {
      await svc.close();
      await nas.close();
    }
  }),
);

test(
  'G3: a restarted saver finds the file by the video id in the name, not by filename equality',
  withNasPassword(async () => {
    const nas = await startNas(['/transcripts']);
    const first = await startService(nas, NAS_TENANTS, {
      now: () => new Date('2026-11-22T00:00:00Z'),
      metadata: async () => ({ title: 'First Title' }),
    });
    try {
      const job = await pollJob(
        first.base,
        (await submitJob(first.base, { origin: discordOrigin(GUILD, CHANNEL), token: NAS_TOKEN })).body.job_id,
      );
      assert.equal(job.saved.path, `/transcripts/first-title_${VIDEO_A}_20261122.md`);
    } finally {
      await first.close();
    }
    // A fresh service has no memory of the file: another day and another
    // title still land on the stored file via the listing's video id.
    const second = await startService(nas, NAS_TENANTS, {
      now: () => new Date('2026-11-23T00:00:00Z'),
      metadata: async () => ({ title: 'Renamed Video' }),
    });
    try {
      const job = await pollJob(
        second.base,
        (await submitJob(second.base, { origin: discordOrigin(GUILD, CHANNEL), token: NAS_TOKEN })).body.job_id,
      );
      assert.equal(job.saved.path, `/transcripts/first-title_${VIDEO_A}_20261122.md`);
      assert.equal(nas.files.size, 1, 'the existing file is updated, not duplicated');
      assert.match(nas.files.get(`/transcripts/first-title_${VIDEO_A}_20261122.md`) ?? '', /^Title: Renamed Video/);
      assert.ok(nas.requests.includes('PROPFIND /transcripts'));
      assert.ok(nas.requests.filter((r) => r === `PUT /transcripts/first-title_${VIDEO_A}_20261122.md`).length === 2);
    } finally {
      await second.close();
      await nas.close();
    }
  }),
);

test(
  'G3: a restarted saver still finds the file by the video id when the base URL has a pathname',
  withNasPassword(async () => {
    const nas = await startNas(['/dav', '/dav/transcripts']);
    const davTenants = NAS_TENANTS.map((t) => ({
      ...t,
      destination: { ...t.destination, base_url: 'https://nas.test/dav' },
    }));
    const first = await startService(nas, davTenants, {
      now: () => new Date('2026-11-22T00:00:00Z'),
      metadata: async () => ({ title: 'First Title' }),
    });
    try {
      const job = await pollJob(
        first.base,
        (await submitJob(first.base, { origin: discordOrigin(GUILD, CHANNEL), token: NAS_TOKEN })).body.job_id,
      );
      // The reply path shows the configured folder, not the endpoint prefix.
      assert.equal(job.saved.path, `/transcripts/first-title_${VIDEO_A}_20261122.md`);
      assert.equal(job.saved.folder, '/transcripts');
    } finally {
      await first.close();
    }
    // A fresh service has no memory of the file: another day and another
    // title still land on the stored file even though every href the server
    // returns starts with the /dav endpoint prefix.
    const second = await startService(nas, davTenants, {
      now: () => new Date('2026-11-23T00:00:00Z'),
      metadata: async () => ({ title: 'Renamed Video' }),
    });
    try {
      const job = await pollJob(
        second.base,
        (await submitJob(second.base, { origin: discordOrigin(GUILD, CHANNEL), token: NAS_TOKEN })).body.job_id,
      );
      assert.equal(job.saved.path, `/transcripts/first-title_${VIDEO_A}_20261122.md`);
      assert.equal(nas.files.size, 1, 'the existing file is updated, not duplicated');
      assert.match(
        nas.files.get(`/dav/transcripts/first-title_${VIDEO_A}_20261122.md`) ?? '',
        /^Title: Renamed Video/,
      );
      assert.ok(nas.requests.includes('PROPFIND /dav/transcripts'));
      assert.ok(
        nas.requests.filter((r) => r === `PUT /dav/transcripts/first-title_${VIDEO_A}_20261122.md`)
          .length === 2,
      );
    } finally {
      await second.close();
      await nas.close();
    }
  }),
);

// --- G4: failure reporting ----------------------------------------------------

test(
  'G4: a 401 reports the fixed save_failed at the origin and still returns the transcript; nothing upstream leaks',
  async () => {
    process.env[NAS_ENV] = 'wrong-password';
    const nas = await startNas();
    const svc = await startService(nas, NAS_TENANTS);
    try {
      const res = await submitJob(svc.base, { origin: discordOrigin(GUILD, CHANNEL), token: NAS_TOKEN });
      const job = await pollJob(svc.base, res.body.job_id);
      assert.equal(job.status, 'done');
      assert.ok(job.result.blocks.length > 0, 'the transcript is still returned');
      assert.equal(job.saved, undefined);
      assert.equal(job.save_error.code, 'save_failed');
      assert.equal(job.save_error.status, 401);
      const leaks = [NAS_PASSWORD, 'wrong-password', 'upstream-rejection-marker-99'];
      for (const text of leaks) {
        assert.ok(!JSON.stringify(job).includes(text), `job view leaks ${text}`);
        assert.ok(!svc.logs.join('\n').includes(text), `logs leak ${text}`);
      }

      const replies = await botReplyFor(svc, `https://youtu.be/${VIDEO_A}`);
      assert.equal(replies.length, 1);
      assert.match(replies[0].content, /couldn't save/i);
      assert.equal(replies[0].files.length, 2, 'transcript attachments still sent');
      for (const text of leaks) {
        assert.ok(!replies[0].content.includes(text), `reply leaks ${text}`);
      }
    } finally {
      delete process.env[NAS_ENV];
      await svc.close();
      await nas.close();
    }
  },
);

test(
  'G4: an unreachable server reports the fixed save_failed and still returns the transcript',
  withNasPassword(async () => {
    const nas = await startNas(['/transcripts']);
    const svc = await startService(nas, NAS_TENANTS);
    try {
      await nas.close(); // the store now refuses connections
      const res = await submitJob(svc.base, { origin: discordOrigin(GUILD, CHANNEL), token: NAS_TOKEN });
      const job = await pollJob(svc.base, res.body.job_id);
      assert.equal(job.status, 'done');
      assert.ok(job.result.blocks.length > 0);
      assert.equal(job.saved, undefined);
      assert.equal(job.save_error.code, 'save_failed');
      assert.ok(!JSON.stringify(job).includes(NAS_PASSWORD));
      assert.ok(!svc.logs.join('\n').includes(NAS_PASSWORD));
    } finally {
      await svc.close();
    }
  }),
);

// --- G6: TLS only -------------------------------------------------------------

test('G6: an http:// base URL is refused at config load with a fixed message', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fa-nas-'));
  const file = join(dir, 'tenants.json');
  for (const bad of [
    'http://nas.test',
    'ftp://nas.test',
    'nas.test',
    'https://user:pw@nas.test',
    'https://nas.test/?query=1',
    'https://nas.test/#frag',
  ]) {
    writeFileSync(
      file,
      JSON.stringify({
        tenants: [
          {
            id: 'x',
            destination: {
              type: 'webdav',
              base_url: bad,
              path: '/t',
              username: 'u',
              password_env: 'E',
            },
          },
        ],
      }),
    );
    let message = '';
    try {
      loadTenantsFile(file);
    } catch (err) {
      assert.ok(err instanceof TranscriptError, `base ${bad}`);
      message = err.message;
    }
    assert.match(message, /https:\/\/ base_url/, `base ${bad}`);
    assert.ok(!message.includes(bad), 'the refused URL is not echoed');
  }
});

test('a webdav destination needs username and password_env, not the password itself', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fa-nas-'));
  const file = join(dir, 'tenants.json');
  const dest = (extra: object) =>
    writeFileSync(
      file,
      JSON.stringify({
        tenants: [{ id: 'x', destination: { type: 'webdav', base_url: NAS_BASE, path: '/t', ...extra } }],
      }),
    );
  dest({});
  assert.throws(() => loadTenantsFile(file), /username/);
  dest({ username: 'u' });
  assert.throws(() => loadTenantsFile(file), /password_env/);
  dest({ username: 'u', password_env: 'E', password: 'literal-secret' });
  const tenants = loadTenantsFile(file);
  assert.equal(tenants[0].destination?.type, 'webdav');
  // Extra keys are ignored; nothing in the parsed destination can hold a password.
  assert.ok(!JSON.stringify(tenants).includes('literal-secret'));
});

// --- redirect confinement ------------------------------------------------------

test(
  'a redirect answer is a fixed failure for every method — no hop is followed, nothing is resent',
  async () => {
    const victimHits: string[] = [];
    const victim = createServer((req, res) => {
      victimHits.push(`${req.method} ${req.url}`);
      res.writeHead(201);
      res.end();
    });
    await new Promise<void>((resolve) => victim.listen(0, '127.0.0.1', resolve));
    const victimPort = (victim.address() as AddressInfo).port;
    try {
      const redirectCodes = [301, 302, 303, 307, 308];
      const redirecterHits: string[] = [];
      let n = 0;
      const redirecter = createServer((req, res) => {
        redirecterHits.push(`${req.method} ${req.url}`);
        const code = redirectCodes[n++ % redirectCodes.length];
        res.writeHead(code, { location: `http://127.0.0.1:${victimPort}/outside/victim.txt` });
        res.end();
      });
      await new Promise<void>((resolve) => redirecter.listen(0, '127.0.0.1', resolve));
      const port = (redirecter.address() as AddressInfo).port;
      try {
        const seenInits: (RequestInit | undefined)[] = [];
        const mapped = nasFetch(port);
        const spyFetch = ((input: string | URL | Request, init?: RequestInit) => {
          seenInits.push(init);
          return mapped(input, init);
        }) as typeof fetch;
        const base = parseWebdavBaseUrl(NAS_BASE);
        assert.ok(base);
        const store = createWebdavStore({
          baseUrl: base,
          path: '/transcripts',
          username: NAS_USER,
          password: NAS_PASSWORD,
          fetchImpl: spyFetch,
        });
        await assert.rejects(() => store.findFileByVideoId(VIDEO_A), WebdavError);
        await assert.rejects(
          () => store.createFile('ok_name.txt', 'private transcript', 'text/plain'),
          WebdavError,
        );
        await assert.rejects(
          () => store.updateFile('/transcripts/ok_name.txt', 'private transcript', 'text/plain'),
          WebdavError,
        );
        assert.deepEqual(redirecterHits, [
          'PROPFIND /transcripts',
          'PUT /transcripts/ok_name.txt',
          'PUT /transcripts/ok_name.txt',
        ]);
        assert.deepEqual(victimHits, [], 'no request followed a redirect');
        assert.ok(seenInits.length > 0);
        assert.ok(
          seenInits.every((i) => i?.redirect === 'manual'),
          'every WebDAV request opts out of redirect following',
        );
      } finally {
        await new Promise<void>((resolve) => redirecter.close(() => resolve()));
      }
    } finally {
      await new Promise<void>((resolve) => victim.close(() => resolve()));
    }
  },
);

test('a redirect on the MKCOL retry fails closed too', async () => {
  const victimHits: string[] = [];
  const victim = createServer((req, res) => {
    victimHits.push(`${req.method} ${req.url}`);
    res.writeHead(201);
    res.end();
  });
  await new Promise<void>((resolve) => victim.listen(0, '127.0.0.1', resolve));
  const victimPort = (victim.address() as AddressInfo).port;
  try {
    const hits: string[] = [];
    const server = createServer((req, res) => {
      hits.push(`${req.method} ${req.url}`);
      if (req.method === 'PUT') {
        // A missing folder takes the MKCOL path; the MKCOL answer redirects.
        res.writeHead(404);
      } else {
        res.writeHead(307, { location: `http://127.0.0.1:${victimPort}/outside/mkcol` });
      }
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    try {
      const base = parseWebdavBaseUrl(NAS_BASE);
      assert.ok(base);
      const store = createWebdavStore({
        baseUrl: base,
        path: '/transcripts',
        username: NAS_USER,
        password: NAS_PASSWORD,
        fetchImpl: nasFetch(port),
      });
      await assert.rejects(
        () => store.createFile('ok_name.txt', 'private transcript', 'text/plain'),
        WebdavError,
      );
      assert.deepEqual(hits, ['PUT /transcripts/ok_name.txt', 'MKCOL /transcripts']);
      assert.deepEqual(victimHits, []);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  } finally {
    await new Promise<void>((resolve) => victim.close(() => resolve()));
  }
});

// --- reply path boundary -------------------------------------------------------

test('the API client renders a webdav saved link only from folder + name, never a wire path string', async () => {
  const savedJob = (saved: unknown) => ({
    status: 'done',
    result: {
      video_id: VIDEO_A,
      source_url: `https://youtu.be/${VIDEO_A}`,
      language: 'en',
      blocks: [],
    },
    saved,
  });
  const clientFor = (saved: unknown) => {
    let n = 0;
    return createApiClient({
      baseUrl: 'http://test',
      fetchImpl: (async () =>
        ++n === 1
          ? Response.json({ job_id: 'j' }, { status: 202 })
          : Response.json(savedJob(saved))) as typeof fetch,
    });
  };

  const legit = await clientFor({
    type: 'webdav',
    name: 'ok_name.txt',
    folder: '/transcripts',
    path: '/transcripts/ok_name.txt',
  }).transcribe('url', 'key');
  assert.equal(legit.saved?.type, 'webdav');
  if (legit.saved?.type === 'webdav') {
    assert.equal(legit.saved.path, '/transcripts/ok_name.txt');
  }

  // A ready-made wire `path` is never trusted: without a valid folder + name
  // structure the whole saved value is dropped, marker text and all.
  const marker = '/UPSTREAM_ERROR password=secret-token @everyone';
  const marked = await clientFor({ type: 'webdav', name: 'ok.txt', path: marker }).transcribe(
    'url',
    'key',
  );
  assert.equal(marked.saved, undefined);

  for (const saved of [
    { type: 'webdav', name: 'ok.txt', folder: '/a/../b', path: '/a/../b/ok.txt' },
    { type: 'webdav', name: 'ok.txt', folder: '/a\\b', path: '/a\\b/ok.txt' },
    { type: 'webdav', name: 'ok.txt', folder: '/a\nb', path: '/a\nb/ok.txt' },
    { type: 'webdav', name: '@everyone', folder: '/transcripts' },
    { type: 'webdav', name: 'a/b.txt', folder: '/transcripts' },
    { type: 'webdav', name: 'a%2Fb.txt', folder: '/transcripts' },
    { type: 'webdav', name: 'free text.txt', folder: '/transcripts' },
  ]) {
    const outcome = await clientFor(saved).transcribe('url', 'key');
    assert.equal(outcome.saved, undefined, JSON.stringify(saved));
  }

  // A legitimate configured folder with a space keeps working through
  // explicit encoding in the canonical reply path.
  const spaced = await clientFor({
    type: 'webdav',
    name: 'ok.txt',
    folder: '/folder with space',
  }).transcribe('url', 'key');
  if (spaced.saved?.type !== 'webdav') {
    assert.fail('a configured folder with a space must still produce a reply path');
  }
  assert.equal(spaced.saved.path, '/folder%20with%20space/ok.txt');
});

// --- units --------------------------------------------------------------------

test('parse helpers: base URL, folder and display path', () => {
  assert.equal(parseWebdavBaseUrl('https://nas.test'), 'https://nas.test');
  assert.equal(parseWebdavBaseUrl('https://nas.test:8443/dav/'), 'https://nas.test:8443/dav');
  assert.equal(parseWebdavBaseUrl('http://nas.test'), undefined);
  assert.equal(parseWebdavBaseUrl('https://u:p@nas.test'), undefined);
  assert.equal(parseWebdavBaseUrl(42), undefined);

  assert.deepEqual(parseWebdavFolder('/a/b/c'), ['a', 'b', 'c']);
  assert.deepEqual(parseWebdavFolder('a/b'), ['a', 'b']);
  assert.deepEqual(parseWebdavFolder('/folder with space'), ['folder with space']);
  assert.equal(parseWebdavFolder('/a/../b'), undefined);
  assert.equal(parseWebdavFolder('/a\\b'), undefined);
  assert.equal(parseWebdavFolder('/'), undefined);

  assert.equal(webdavPath('/t', 'f.txt'), '/t/f.txt');
  assert.equal(webdavPath('/a/b', 'f.txt'), '/a/b/f.txt');
  assert.equal(webdavPath('/folder with space', 'f.txt'), '/folder%20with%20space/f.txt');
  assert.equal(webdavPath('/a/../b', 'f.txt'), undefined);
  assert.equal(webdavPath('/a\\b', 'f.txt'), undefined);
  assert.equal(webdavPath('/a\nb', 'f.txt'), undefined);
  assert.equal(webdavPath('/t', 'bad name.txt'), undefined);
  assert.equal(webdavPath('/t', 'a%2Fb.txt'), undefined);
  assert.equal(webdavPath(42, 'f.txt'), undefined);
});

test('nameMatchesVideoId: the video id in the name is the identity, anchored exactly', () => {
  assert.ok(nameMatchesVideoId(`my-title_${VIDEO_A}_20261122.txt`, VIDEO_A));
  assert.ok(nameMatchesVideoId(`${VIDEO_A}_${VIDEO_A}_20261122.txt`, VIDEO_A)); // empty-slug fallback
  assert.ok(!nameMatchesVideoId(`my-title_${VIDEO_B}_20261122.txt`, VIDEO_A));
  assert.ok(!nameMatchesVideoId(`other_${VIDEO_A}.txt`, VIDEO_A));
  assert.ok(!nameMatchesVideoId(`prefix_x${VIDEO_A.slice(1)}_20261122.txt`, VIDEO_A));
});
