import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createService } from '../src/service.js';
import type { GeminiCaller } from '../src/gemini.js';
import { DriveError, type DriveStore } from '../src/drive.js';
import { englishSlug, renderTranscriptFile } from '../src/save.js';
import { loadTenantsFile, resolveTenant, type JobOrigin } from '../src/tenants.js';
import { TranscriptError } from '../src/errors.js';
import { createApiClient, type SavedLink } from '../src/bot/api.js';
import { createBot, type AttachmentFile } from '../src/bot/core.js';
import { deriveEncryptionKey } from '../src/bot/crypto.js';
import { GuildStore } from '../src/bot/store.js';

const GOOD = readFileSync(new URL('./fixtures/model-good.txt', import.meta.url), 'utf8');
const VIDEO_A = 'hWe-j78vNpc';
const VIDEO_B = 'dQw4w9WgXcQ';
const KEY = 'TEST-KEY-SAVE-k7k7k7';
const FIXED_NOW = new Date('2026-11-22T03:00:00Z');
const META = { title: 'My Great Video!', channel: 'Test Channel' };
const GUILD = 'guild-1';
const CHANNEL = 'channel-1';
const THREAD = 'thread-1';

// --- Drive API test double ---------------------------------------------------

interface FakeStored {
  id: string;
  folder: string;
  name: string;
  content: string;
  url: string;
}

class FakeDrive implements DriveStore {
  readonly files: FakeStored[] = [];
  readonly calls: string[] = [];
  failWith?: DriveError;
  private seq = 0;

  filesIn(folder: string): FakeStored[] {
    return this.files.filter((f) => f.folder === folder);
  }

  async findFile(folderId: string, name: string) {
    this.calls.push(`find:${folderId}:${name}`);
    if (this.failWith) throw this.failWith;
    return this.filesIn(folderId).find((f) => f.name === name) ?? null;
  }

  async createFile(folderId: string, name: string, content: string) {
    this.calls.push(`create:${folderId}:${name}`);
    if (this.failWith) throw this.failWith;
    const file: FakeStored = {
      id: `fake-drive-${++this.seq}`,
      folder: folderId,
      name,
      content,
      url: `https://drive.example.test/${folderId}/${name}`,
    };
    this.files.push(file);
    return { id: file.id, name, url: file.url };
  }

  async updateFile(fileId: string, content: string) {
    this.calls.push(`update:${fileId}`);
    if (this.failWith) throw this.failWith;
    const file = this.files.find((f) => f.id === fileId);
    assert.ok(file, `update for unknown file ${fileId}`);
    file.content = content;
    return { id: file.id, name: file.name, url: file.url };
  }
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
  drive: FakeDrive,
  tenants: unknown,
): Promise<RunningService> {
  const dir = mkdtempSync(join(tmpdir(), 'fa-save-'));
  const tenantsFile = writeTenantsFile(dir, tenants);
  const logs: string[] = [];
  const caller: GeminiCaller = async () => ({ text: GOOD, status: 'completed' });
  const server: Server = createService({
    callerFactory: () => caller,
    model: 'test-model',
    maxBlockSeconds: 8,
    cacheDir: mkdtempSync(join(tmpdir(), 'fa-save-cache-')),
    tenantsFile,
    drive,
    videoMetadata: async () => META,
    now: () => FIXED_NOW,
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
  opts: { url?: string; origin?: unknown } = {},
): Promise<HttpResult> {
  const res = await fetch(`${base}/v1/jobs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-gemini-key': KEY },
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

const TENANTS_TWO = [
  {
    id: 'tenant-a',
    discord_guild_id: 'guild-a',
    destination: { type: 'google-drive', folder_id: 'folder-a' },
  },
  {
    id: 'tenant-b',
    discord_guild_id: 'guild-b',
    destination: { type: 'google-drive', folder_id: 'folder-b', extension: '.md' },
  },
];

// --- E1: tenant isolation -----------------------------------------------------

test('E1: each tenant writes only into its own folder', async () => {
  const drive = new FakeDrive();
  const svc = await startService(drive, TENANTS_TWO);
  try {
    const resA = await submitJob(svc.base, { origin: discordOrigin('guild-a', 'chan-1') });
    assert.equal(resA.status, 202);
    const jobA = await pollJob(svc.base, resA.body.job_id);
    assert.equal(jobA.status, 'done');
    assert.equal(jobA.saved.type, 'google-drive');
    assert.equal(jobA.saved.url, `https://drive.example.test/folder-a/my-great-video_20261122.txt`);

    const resB = await submitJob(svc.base, {
      url: `https://youtu.be/${VIDEO_B}`,
      origin: discordOrigin('guild-b', 'chan-2'),
    });
    const jobB = await pollJob(svc.base, resB.body.job_id);
    assert.equal(jobB.status, 'done');
    assert.equal(jobB.saved.url, `https://drive.example.test/folder-b/my-great-video_20261122.md`);

    assert.equal(drive.filesIn('folder-a').length, 1);
    assert.equal(drive.filesIn('folder-b').length, 1);
    assert.equal(drive.filesIn('folder-a')[0].name, 'my-great-video_20261122.txt');
    assert.equal(drive.filesIn('folder-b')[0].name, 'my-great-video_20261122.md');
    // Nothing ever wrote outside the two configured folders.
    assert.equal(drive.files.length, 2);
  } finally {
    await svc.close();
  }
});

// --- E2: the link reaches the web result and the Discord reply ----------------

test('E2: a web job result and a Discord thread reply both carry the file link', async () => {
  const drive = new FakeDrive();
  const svc = await startService(drive, [
    {
      id: 'web-allen',
      web_identities: ['allen'],
      destination: { type: 'google-drive', folder_id: 'folder-web' },
    },
    {
      id: 'tenant-guild',
      discord_guild_id: GUILD,
      discord_channel_ids: [CHANNEL],
      destination: { type: 'google-drive', folder_id: 'folder-guild' },
    },
  ]);
  try {
    // The web result: the job payload a page polls carries saved.url.
    const res = await submitJob(svc.base, { origin: { kind: 'web', identity: 'allen' } });
    const job = await pollJob(svc.base, res.body.job_id);
    assert.equal(job.status, 'done');
    assert.equal(job.saved.url, `https://drive.example.test/folder-web/my-great-video_20261122.txt`);

    // The Discord reply goes through the real bot api client and core.
    const dir = mkdtempSync(join(tmpdir(), 'fa-save-bot-'));
    const store = new GuildStore(join(dir, 'bot-data.json'), deriveEncryptionKey('test-secret'));
    store.setKey(GUILD, KEY);
    store.enableChannel(GUILD, CHANNEL);
    const api = createApiClient({ baseUrl: svc.base, pollIntervalMs: 5, timeoutMs: 10_000 });
    const core = createBot({ api, store });
    const replies: { content: string; files: AttachmentFile[]; link?: SavedLink }[] = [];
    await core.handleMessage(
      {
        guildId: GUILD,
        channelId: THREAD,
        parentChannelId: CHANNEL,
        authorIsBot: false,
        content: `check this https://youtu.be/${VIDEO_B}`,
      },
      {
        react: async () => {},
        reply: async (content, files, link) => {
          replies.push({ content, files, link });
        },
      },
    );

    assert.equal(replies.length, 1);
    // The link reaches the reply sink as validated structured data; the
    // Discord adapter renders it as "Saved to Drive: <url>" under the text.
    assert.equal(
      replies[0].link?.url,
      'https://drive.example.test/folder-guild/my-great-video_20261122.txt',
    );
    assert.equal(replies[0].files.length, 2);
    assert.equal(drive.filesIn('folder-guild').length, 1);
  } finally {
    await svc.close();
  }
});

// --- E3: write failure is reported and the transcript is still returned -------

test('E3: a 403 from Drive reports save_failed at the origin and still returns the transcript', async () => {
  const drive = new FakeDrive();
  drive.failWith = new DriveError(
    'Drive API error 403: forbidden — is the folder shared with the service account email?',
    403,
  );
  const svc = await startService(drive, [
    {
      id: 'tenant-guild',
      discord_guild_id: GUILD,
      discord_channel_ids: [CHANNEL],
      destination: { type: 'google-drive', folder_id: 'folder-unshared' },
    },
  ]);
  try {
    // The web result carries the error; the transcript still came back.
    const res = await submitJob(svc.base, { origin: discordOrigin(GUILD, CHANNEL) });
    const job = await pollJob(svc.base, res.body.job_id);
    assert.equal(job.status, 'done');
    assert.ok(job.result.blocks.length > 0, 'transcript must still be returned');
    assert.equal(job.saved, undefined);
    assert.equal(job.save_error.code, 'save_failed');
    assert.equal(job.save_error.status, 403);
    assert.match(job.save_error.message, /shared with the service account/);

    // The Discord reply shows the failure and still attaches the transcript.
    const dir = mkdtempSync(join(tmpdir(), 'fa-save-bot-'));
    const store = new GuildStore(join(dir, 'bot-data.json'), deriveEncryptionKey('test-secret'));
    store.setKey(GUILD, KEY);
    store.enableChannel(GUILD, CHANNEL);
    const api = createApiClient({ baseUrl: svc.base, pollIntervalMs: 5, timeoutMs: 10_000 });
    const core = createBot({ api, store });
    const replies: { content: string; files: AttachmentFile[] }[] = [];
    await core.handleMessage(
      {
        guildId: GUILD,
        channelId: THREAD,
        parentChannelId: CHANNEL,
        authorIsBot: false,
        content: `check this https://youtu.be/${VIDEO_A}`,
      },
      {
        react: async () => {},
        reply: async (content, files) => {
          replies.push({ content, files });
        },
      },
    );

    assert.equal(replies.length, 1);
    assert.match(replies[0].content, /couldn't save/i);
    assert.equal(replies[0].files.length, 2, 'transcript attachments still sent');
    assert.equal(drive.files.length, 0);
  } finally {
    await svc.close();
  }
});

// --- E4: same video, same tenant: update, not duplicate -----------------------

test('E4: running the same video twice for one tenant updates the file in place', async () => {
  const drive = new FakeDrive();
  const svc = await startService(drive, TENANTS_TWO);
  try {
    for (let i = 0; i < 2; i++) {
      const res = await submitJob(svc.base, { origin: discordOrigin('guild-a', 'chan-1') });
      const job = await pollJob(svc.base, res.body.job_id);
      assert.equal(job.status, 'done');
      assert.equal(job.saved.url, `https://drive.example.test/folder-a/my-great-video_20261122.txt`);
    }
    const files = drive.filesIn('folder-a');
    assert.equal(files.length, 1, 'no duplicate file');
    assert.ok(
      drive.calls.includes(`update:${files[0].id}`),
      'second save must update in place',
    );
  } finally {
    await svc.close();
  }
});

// --- E5: a new tenant is configuration, not code -------------------------------

test('E5: adding a third tenant by editing only the tenants file works', async () => {
  const drive = new FakeDrive();
  const svc = await startService(drive, TENANTS_TWO);
  try {
    const before = await submitJob(svc.base, { origin: discordOrigin('guild-c', 'chan-9') });
    const jobBefore = await pollJob(svc.base, before.body.job_id);
    assert.equal(jobBefore.status, 'done');
    assert.equal(jobBefore.saved, undefined, 'unmatched origin saves nothing');
    assert.equal(drive.files.length, 0);

    // Edit only the file: the next job resolves the new tenant.
    writeTenantsFile(svc.dir, [
      ...TENANTS_TWO,
      {
        id: 'tenant-c',
        discord_guild_id: 'guild-c',
        destination: { type: 'google-drive', folder_id: 'folder-c', extension: '.srt' },
      },
    ]);
    const after = await submitJob(svc.base, { origin: discordOrigin('guild-c', 'chan-9') });
    const jobAfter = await pollJob(svc.base, after.body.job_id);
    assert.equal(jobAfter.status, 'done');
    assert.equal(jobAfter.saved.url, `https://drive.example.test/folder-c/my-great-video_20261122.srt`);
    assert.equal(drive.filesIn('folder-c').length, 1);
  } finally {
    await svc.close();
  }
});

// --- E6: file name and format --------------------------------------------------

test('E6: the written file is named by slug and date, with the header then timestamped text', async () => {
  const drive = new FakeDrive();
  const svc = await startService(drive, TENANTS_TWO);
  try {
    const res = await submitJob(svc.base, { origin: discordOrigin('guild-a', 'chan-1') });
    await pollJob(svc.base, res.body.job_id);

    const file = drive.filesIn('folder-a')[0];
    assert.equal(file.name, 'my-great-video_20261122.txt');
    const head = file.content.split('\n\n')[0];
    assert.match(head, /^Title: My Great Video!\n/);
    assert.match(head, /Channel: Test Channel\n/);
    assert.match(head, new RegExp(`Source: https://www\\.youtube\\.com/watch\\?v=${VIDEO_A}\n`));
    assert.match(head, /Captured: 2026-11-22$/);
    assert.match(file.content, /\n\[0:00\] /, 'timestamped text follows the header');
  } finally {
    await svc.close();
  }
});

// --- E7: no credentials or tenant data in the repo ------------------------------

test('E7: no credential material is tracked, and the README documents the setup', () => {
  const repo = dirname(new URL('../package.json', import.meta.url).pathname);
  const tracked = execFileSync('git', ['ls-files'], { cwd: repo, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean)
    .filter((f) => !f.startsWith('test/fixtures/') && !/\.(png|jpg|ico)$/.test(f));
  const credentialShapes = [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
    /"private_key"\s*:/,
    /iam\.gserviceaccount\.com/,
  ];
  for (const file of tracked) {
    const text = readFileSync(join(repo, file), 'utf8');
    for (const shape of credentialShapes) {
      assert.ok(!shape.test(text), `credential shape ${shape} found in ${file}`);
    }
  }

  const readme = readFileSync(join(repo, 'README.md'), 'utf8');
  for (const needle of ['TENANTS_FILE', 'GOOGLE_APPLICATION_CREDENTIALS', 'client_email']) {
    assert.ok(readme.includes(needle), `README must document ${needle}`);
  }
  assert.match(readme, /[Ss]hare[^\n]*folder|folder[^\n]*[Ss]hare/);
});

// --- supporting behaviour ------------------------------------------------------

test('a job with no origin, or an origin matching no tenant, saves nothing', async () => {
  const drive = new FakeDrive();
  const svc = await startService(drive, TENANTS_TWO);
  try {
    const plain = await pollJob(svc.base, (await submitJob(svc.base)).body.job_id);
    assert.equal(plain.status, 'done');
    assert.equal(plain.saved, undefined);
    assert.equal(plain.save_error, undefined);

    const unmatched = await pollJob(
      svc.base,
      (await submitJob(svc.base, { origin: discordOrigin('stranger', 'chan') })).body.job_id,
    );
    assert.equal(unmatched.status, 'done');
    assert.equal(unmatched.saved, undefined);
    assert.equal(drive.files.length, 0);
  } finally {
    await svc.close();
  }
});

test('a none destination and a channel-scoped tenant resolve as configured', async () => {
  const drive = new FakeDrive();
  const svc = await startService(drive, [
    {
      id: 'channel-only',
      discord_guild_id: 'guild-x',
      discord_channel_ids: ['chan-yes'],
      destination: { type: 'google-drive', folder_id: 'folder-x' },
    },
    {
      id: 'loud-no',
      web_identities: ['nobody'],
      destination: { type: 'none' },
    },
  ]);
  try {
    // A channel outside the tenant's list resolves to nothing, not to it.
    const wrong = await pollJob(
      svc.base,
      (await submitJob(svc.base, { origin: discordOrigin('guild-x', 'chan-no') })).body.job_id,
    );
    assert.equal(wrong.saved, undefined);

    const right = await pollJob(
      svc.base,
      (await submitJob(svc.base, { origin: discordOrigin('guild-x', 'chan-yes') })).body.job_id,
    );
    assert.equal(right.saved.url, `https://drive.example.test/folder-x/my-great-video_20261122.txt`);

    const none = await pollJob(
      svc.base,
      (await submitJob(svc.base, { origin: { kind: 'web', identity: 'nobody' } })).body.job_id,
    );
    assert.equal(none.saved, undefined);
    assert.equal(drive.filesIn('folder-x').length, 1);
    assert.equal(drive.files.length, 1);
  } finally {
    await svc.close();
  }
});

test('malformed origins are a 400 invalid_request', async () => {
  const drive = new FakeDrive();
  const svc = await startService(drive, TENANTS_TWO);
  try {
    for (const origin of [
      'discord',
      { kind: 'discord' },
      { kind: 'discord', guild_id: 'g' },
      { kind: 'web' },
      { kind: 'telegram', id: 'x' },
      42,
    ]) {
      const res = await submitJob(svc.base, { origin });
      assert.equal(res.status, 400, `origin ${JSON.stringify(origin)}`);
      assert.equal(res.body.error.code, 'invalid_request');
    }
  } finally {
    await svc.close();
  }
});

// --- units: slug, render, tenant resolution ------------------------------------

test('englishSlug: lowercase ASCII slug, empty slugs fall back', () => {
  assert.equal(englishSlug('My Great Video!', 'fb'), 'my-great-video');
  assert.equal(englishSlug('  Café & Crème  ', 'fb'), 'cafe-creme');
  assert.equal(englishSlug('中文字幕影片', 'hWe-j78vNpc'), 'hWe-j78vNpc');
  assert.equal(englishSlug('a'.repeat(200), 'fb').length <= 60, true);
});

test('renderTranscriptFile: .srt carries the header then cues', () => {
  const out = renderTranscriptFile(
    {
      video_id: VIDEO_A,
      source_url: `https://www.youtube.com/watch?v=${VIDEO_A}`,
      language: 'en',
      blocks: [
        { start: 0, end: 1.5, text: 'hello' },
        { start: 1.5, end: 3, text: 'world' },
      ],
    },
    META,
    '.srt',
    FIXED_NOW,
  );
  assert.match(out, /^Title: My Great Video!\nChannel: Test Channel\n/);
  assert.match(out, /Captured: 2026-11-22\n\n1\n00:00:00,000 --> 00:00:01,500\nhello/);
  assert.match(out, /2\n00:00:01,500 --> 00:00:03,000\nworld/);
});

test('resolveTenant: channel-scoped beats guild-wide; web matches by identity', () => {
  const tenants = [
    { id: 'guild-wide', discord_guild_id: 'g', destination: { type: 'none' as const } },
    {
      id: 'channel-scoped',
      discord_guild_id: 'g',
      discord_channel_ids: ['c1'],
      destination: { type: 'none' as const },
    },
    { id: 'webby', web_identities: ['w1'], destination: { type: 'none' as const } },
  ];
  assert.equal(
    resolveTenant(tenants, { kind: 'discord', guild_id: 'g', channel_id: 'c1' })?.id,
    'channel-scoped',
  );
  assert.equal(
    resolveTenant(tenants, { kind: 'discord', guild_id: 'g', channel_id: 'c9' })?.id,
    'guild-wide',
  );
  assert.equal(resolveTenant(tenants, { kind: 'web', identity: 'w1' })?.id, 'webby');
  assert.equal(resolveTenant(tenants, { kind: 'web', identity: 'w2' }), undefined);
});

test('loadTenantsFile rejects bad shapes with invalid_config', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fa-tenants-'));
  const file = join(dir, 'tenants.json');
  writeFileSync(file, 'not json');
  assert.throws(() => loadTenantsFile(file), TranscriptError);

  writeFileSync(file, JSON.stringify({ tenants: [{ id: 'x', destination: { type: 'google-drive' } }] }));
  assert.throws(() => loadTenantsFile(file), /folder_id/);

  writeFileSync(
    file,
    JSON.stringify({
      tenants: [{ id: 'x', destination: { type: 'google-drive', folder_id: 'f', extension: '.pdf' } }],
    }),
  );
  assert.throws(() => loadTenantsFile(file), /extension/);
});
