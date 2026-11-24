import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
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

const sha256 = (token: string): string => createHash('sha256').update(token).digest('hex');

// --- Drive API test double ---------------------------------------------------

interface FakeStored {
  id: string;
  folder: string;
  name: string;
  content: string;
  url: string;
  props: Record<string, string>;
}

class FakeDrive implements DriveStore {
  readonly files: FakeStored[] = [];
  readonly calls: string[] = [];
  failWith?: DriveError;
  private seq = 0;

  filesIn(folder: string): FakeStored[] {
    return this.files.filter((f) => f.folder === folder);
  }

  async findFileByVideoId(folderId: string, videoId: string) {
    this.calls.push(`find-video:${folderId}:${videoId}`);
    if (this.failWith) throw this.failWith;
    return this.filesIn(folderId).find((f) => f.props.videoId === videoId) ?? null;
  }

  async createFile(
    folderId: string,
    name: string,
    content: string,
    _mimeType?: string,
    appProperties: Record<string, string> = {},
  ) {
    this.calls.push(`create:${folderId}:${name}`);
    if (this.failWith) throw this.failWith;
    const file: FakeStored = {
      id: `fake-drive-${++this.seq}`,
      folder: folderId,
      name,
      content,
      url: `https://drive.google.com/file/d/fake-drive-${this.seq}/view`,
      props: appProperties,
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
  opts: { now?: () => Date; metadata?: () => Promise<typeof META> } = {},
): Promise<RunningService> {
  const dir = mkdtempSync(join(tmpdir(), 'fa-save-'));
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
    cacheDir: mkdtempSync(join(tmpdir(), 'fa-save-cache-')),
    tenantsFile,
    drive,
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

const TOKEN_A = 'test-caller-token-a';
const TOKEN_B = 'test-caller-token-b';
const TOKEN_GUILD = 'test-caller-token-guild';

const TENANTS_TWO = [
  {
    id: 'tenant-a',
    discord_guild_id: 'guild-a',
    caller: { token_sha256: sha256(TOKEN_A) },
    destination: { type: 'google-drive', folder_id: 'folder-a' },
  },
  {
    id: 'tenant-b',
    discord_guild_id: 'guild-b',
    caller: { token_sha256: sha256(TOKEN_B) },
    destination: { type: 'google-drive', folder_id: 'folder-b', extension: '.md' },
  },
];

// --- E1: tenant isolation -----------------------------------------------------

test('E1: each tenant writes only into its own folder', async () => {
  const drive = new FakeDrive();
  const svc = await startService(drive, TENANTS_TWO);
  try {
    const resA = await submitJob(svc.base, {
      origin: discordOrigin('guild-a', 'chan-1'),
      token: TOKEN_A,
    });
    assert.equal(resA.status, 202);
    const jobA = await pollJob(svc.base, resA.body.job_id);
    assert.equal(jobA.status, 'done');
    assert.equal(jobA.saved.type, 'google-drive');
    assert.equal(jobA.saved.url, 'https://drive.google.com/file/d/fake-drive-1/view');

    const resB = await submitJob(svc.base, {
      url: `https://youtu.be/${VIDEO_B}`,
      origin: discordOrigin('guild-b', 'chan-2'),
      token: TOKEN_B,
    });
    const jobB = await pollJob(svc.base, resB.body.job_id);
    assert.equal(jobB.status, 'done');
    assert.equal(jobB.saved.url, 'https://drive.google.com/file/d/fake-drive-2/view');

    assert.equal(drive.filesIn('folder-a').length, 1);
    assert.equal(drive.filesIn('folder-b').length, 1);
    assert.equal(drive.filesIn('folder-a')[0].name, `my-great-video_${VIDEO_A}_20261122.txt`);
    assert.equal(drive.filesIn('folder-b')[0].name, `my-great-video_${VIDEO_B}_20261122.md`);
    // Nothing ever wrote outside the two configured folders.
    assert.equal(drive.files.length, 2);
  } finally {
    await svc.close();
  }
});

// The claim in the request body is not authority: only the bearer token the
// tenant entry names can unlock its destination.
test('F1: a claim without the tenant caller credential saves nothing and reports save_unauthorized', async () => {
  const drive = new FakeDrive();
  const svc = await startService(drive, TENANTS_TWO);
  try {
    for (const token of [undefined, 'wrong-token', TOKEN_B]) {
      const res = await submitJob(svc.base, {
        origin: discordOrigin('guild-a', 'chan-1'),
        ...(token === undefined ? {} : { token }),
      });
      assert.equal(res.status, 202);
      const job = await pollJob(svc.base, res.body.job_id);
      assert.equal(job.status, 'done');
      assert.ok(job.result, 'the transcript is still returned');
      assert.equal(job.saved, undefined);
      assert.equal(job.save_error.code, 'save_unauthorized');
      assert.equal(typeof job.save_error.message, 'string');
    }
    // Tenant B's token cannot claim tenant A's origin either (covered above);
    // no request wrote anywhere.
    assert.equal(drive.files.length, 0);
  } finally {
    await svc.close();
  }
});

// --- E2: the link reaches the web result and the Discord reply ----------------

test('E2: an unauthenticated web result carries no link; a verified Discord reply does', async () => {
  const drive = new FakeDrive();
  const svc = await startService(drive, [
    {
      id: 'tenant-guild',
      discord_guild_id: GUILD,
      discord_channel_ids: [CHANNEL],
      caller: { token_sha256: sha256(TOKEN_GUILD) },
      destination: { type: 'google-drive', folder_id: 'folder-guild' },
    },
  ]);
  try {
    // A web caller is anonymous until sign-in (#6): the job still returns
    // the transcript, but there is no save and no link.
    const res = await submitJob(svc.base, { origin: { kind: 'web', identity: 'allen' } });
    const job = await pollJob(svc.base, res.body.job_id);
    assert.equal(job.status, 'done');
    assert.ok(job.result, 'the transcript is still returned');
    assert.equal(job.saved, undefined);
    assert.equal(job.save_error, undefined);
    assert.equal(drive.files.length, 0);

    // The Discord reply goes through the real bot api client and core; the
    // bot's service token is the caller credential the tenant entry names.
    const dir = mkdtempSync(join(tmpdir(), 'fa-save-bot-'));
    const store = new GuildStore(join(dir, 'bot-data.json'), deriveEncryptionKey('test-secret'));
    store.setKey(GUILD, KEY);
    store.enableChannel(GUILD, CHANNEL);
    const api = createApiClient({
      baseUrl: svc.base,
      serviceToken: TOKEN_GUILD,
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
    // The link reaches the reply sink as a branded canonical Drive link; the
    // Discord adapter renders it as "Saved to Drive: <url>" under the text.
    assert.equal(replies[0].link?.url, 'https://drive.google.com/file/d/fake-drive-1/view');
    assert.equal(replies[0].files.length, 2);
    assert.equal(drive.filesIn('folder-guild').length, 1);
  } finally {
    await svc.close();
  }
});

// --- log fields: a failed Drive save logs the HTTP status and Google's reason ---

test('file_save_failed logs httpStatus and apiReason, never the error message', async () => {
  const drive = new FakeDrive();
  drive.failWith = new DriveError(
    'Drive API error 403: forbidden — is the folder shared with the service account email?',
    403,
    'insufficientFilePermissions',
  );
  const svc = await startService(drive, [
    {
      id: 'tenant-guild',
      discord_guild_id: GUILD,
      discord_channel_ids: [CHANNEL],
      caller: { token_sha256: sha256(TOKEN_GUILD) },
      destination: { type: 'google-drive', folder_id: 'folder-unshared' },
    },
  ]);
  try {
    const res = await submitJob(svc.base, { origin: discordOrigin(GUILD, CHANNEL), token: TOKEN_GUILD });
    await pollJob(svc.base, res.body.job_id);
    const line = svc.logs.find((l) => l.startsWith('file_save_failed'));
    assert.ok(line, 'file_save_failed line is written');
    assert.match(line, / httpStatus=403 /);
    assert.match(line, / apiReason=insufficientFilePermissions/);
    assert.match(line, / code=save_failed /);
    assert.doesNotMatch(line, /shared with the service account/);
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
      caller: { token_sha256: sha256(TOKEN_GUILD) },
      destination: { type: 'google-drive', folder_id: 'folder-unshared' },
    },
  ]);
  try {
    // The job result carries the error; the transcript still came back.
    const res = await submitJob(svc.base, {
      origin: discordOrigin(GUILD, CHANNEL),
      token: TOKEN_GUILD,
    });
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
    const api = createApiClient({
      baseUrl: svc.base,
      serviceToken: TOKEN_GUILD,
      pollIntervalMs: 5,
      timeoutMs: 10_000,
    });
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
      const res = await submitJob(svc.base, {
        origin: discordOrigin('guild-a', 'chan-1'),
        token: TOKEN_A,
      });
      const job = await pollJob(svc.base, res.body.job_id);
      assert.equal(job.status, 'done');
      assert.equal(job.saved.url, 'https://drive.google.com/file/d/fake-drive-1/view');
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

// File identity is the video id, not the mutable title/date filename: a new
// day or a new title still lands on the same stored file.
test('E4b: the same video on another day and with another title still updates one file', async () => {
  const drive = new FakeDrive();
  let now = new Date('2026-11-22T00:00:00Z');
  let title = 'First Title';
  const svc = await startService(drive, TENANTS_TWO, {
    now: () => now,
    metadata: async () => ({ title, channel: 'Test Channel' }),
  });
  try {
    const first = await pollJob(
      svc.base,
      (
        await submitJob(svc.base, { origin: discordOrigin('guild-a', 'chan-1'), token: TOKEN_A })
      ).body.job_id,
    );
    assert.equal(first.saved.url, 'https://drive.google.com/file/d/fake-drive-1/view');
    assert.equal(drive.filesIn('folder-a')[0].name, `first-title_${VIDEO_A}_20261122.txt`);

    now = new Date('2026-11-23T00:00:00Z');
    title = 'Renamed Video';
    const second = await pollJob(
      svc.base,
      (
        await submitJob(svc.base, { origin: discordOrigin('guild-a', 'chan-1'), token: TOKEN_A })
      ).body.job_id,
    );
    assert.equal(second.saved.url, 'https://drive.google.com/file/d/fake-drive-1/view');

    const files = drive.filesIn('folder-a');
    assert.equal(files.length, 1, 'same video across days and titles stays one file');
    assert.ok(drive.calls.includes(`update:${files[0].id}`));
    assert.match(files[0].content, /^Title: Renamed Video\n/);
  } finally {
    await svc.close();
  }
});

// A fresh saver (as after a service restart) has no in-memory record, so it
// must find the stored file through the persisted video id, not the name.
test('E4c: a restarted saver finds the file by the video id stored on it', async () => {
  const drive = new FakeDrive();
  const first = await startService(drive, TENANTS_TWO, {
    now: () => new Date('2026-11-22T00:00:00Z'),
  });
  try {
    const job = await pollJob(
      first.base,
      (
        await submitJob(first.base, {
          origin: discordOrigin('guild-a', 'chan-1'),
          token: TOKEN_A,
        })
      ).body.job_id,
    );
    assert.equal(job.status, 'done');
    assert.equal(drive.filesIn('folder-a')[0].props.videoId, VIDEO_A);
  } finally {
    await first.close();
  }

  const second = await startService(drive, TENANTS_TWO, {
    now: () => new Date('2026-11-23T00:00:00Z'),
  });
  try {
    const job = await pollJob(
      second.base,
      (
        await submitJob(second.base, {
          origin: discordOrigin('guild-a', 'chan-1'),
          token: TOKEN_A,
        })
      ).body.job_id,
    );
    assert.equal(job.saved.url, 'https://drive.google.com/file/d/fake-drive-1/view');
    const files = drive.filesIn('folder-a');
    assert.equal(files.length, 1, 'a restart must not duplicate the stored file');
    assert.ok(drive.calls.includes(`find-video:folder-a:${VIDEO_A}`));
  } finally {
    await second.close();
  }
});

// Concurrent jobs for the same tenant and video serialize: they converge on
// one file instead of racing find/create into a duplicate.
test('E4d: two concurrent saves of the same video converge to one file', async () => {
  const drive = new FakeDrive();
  const svc = await startService(drive, TENANTS_TWO);
  try {
    const [a, b] = await Promise.all([
      submitJob(svc.base, { origin: discordOrigin('guild-a', 'chan-1'), token: TOKEN_A }),
      submitJob(svc.base, { origin: discordOrigin('guild-a', 'chan-1'), token: TOKEN_A }),
    ]);
    assert.equal(a.status, 202);
    assert.equal(b.status, 202);
    const [jobA, jobB] = await Promise.all([
      pollJob(svc.base, a.body.job_id),
      pollJob(svc.base, b.body.job_id),
    ]);
    assert.equal(jobA.status, 'done');
    assert.equal(jobB.status, 'done');
    const files = drive.filesIn('folder-a');
    assert.equal(files.length, 1, 'concurrent jobs must not duplicate the file');
  } finally {
    await svc.close();
  }
});

// --- E5: a new tenant is configuration, not code -------------------------------

test('E5: adding a third tenant by editing only the tenants file works', async () => {
  const drive = new FakeDrive();
  const svc = await startService(drive, TENANTS_TWO);
  const TOKEN_C = 'test-caller-token-c';
  try {
    const before = await submitJob(svc.base, {
      origin: discordOrigin('guild-c', 'chan-9'),
      token: TOKEN_C,
    });
    const jobBefore = await pollJob(svc.base, before.body.job_id);
    assert.equal(jobBefore.status, 'done');
    assert.equal(jobBefore.saved, undefined, 'unmatched origin saves nothing');
    assert.equal(drive.files.length, 0);

    // Edit only the file: the next job resolves the new tenant. The env
    // reference form of caller credential covers the second variant.
    process.env.FA_TEST_TENANT_C_TOKEN = TOKEN_C;
    writeTenantsFile(svc.dir, [
      ...TENANTS_TWO,
      {
        id: 'tenant-c',
        discord_guild_id: 'guild-c',
        caller: { token_env: 'FA_TEST_TENANT_C_TOKEN' },
        destination: { type: 'google-drive', folder_id: 'folder-c', extension: '.srt' },
      },
    ]);
    const after = await submitJob(svc.base, {
      origin: discordOrigin('guild-c', 'chan-9'),
      token: TOKEN_C,
    });
    const jobAfter = await pollJob(svc.base, after.body.job_id);
    assert.equal(jobAfter.status, 'done');
    assert.equal(jobAfter.saved.url, 'https://drive.google.com/file/d/fake-drive-1/view');
    assert.equal(drive.filesIn('folder-c').length, 1);
    assert.equal(drive.filesIn('folder-c')[0].name, `my-great-video_${VIDEO_A}_20261122.srt`);
  } finally {
    delete process.env.FA_TEST_TENANT_C_TOKEN;
    await svc.close();
  }
});

// --- E6: file name and format --------------------------------------------------

test('E6: the written file is named by slug, video id and date, with the header then timestamped text', async () => {
  const drive = new FakeDrive();
  const svc = await startService(drive, TENANTS_TWO);
  try {
    const res = await submitJob(svc.base, {
      origin: discordOrigin('guild-a', 'chan-1'),
      token: TOKEN_A,
    });
    await pollJob(svc.base, res.body.job_id);

    const file = drive.filesIn('folder-a')[0];
    assert.equal(file.name, `my-great-video_${VIDEO_A}_20261122.txt`);
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
      (await submitJob(svc.base, { origin: discordOrigin('stranger', 'chan'), token: TOKEN_A }))
        .body.job_id,
    );
    assert.equal(unmatched.status, 'done');
    assert.equal(unmatched.saved, undefined);
    assert.equal(unmatched.save_error, undefined, 'an unmatched claim is silent, not denied');
    assert.equal(drive.files.length, 0);
  } finally {
    await svc.close();
  }
});

test('a none destination and a channel-scoped tenant resolve as configured', async () => {
  const TOKEN_X = 'test-caller-token-x';
  const TOKEN_NONE = 'test-caller-token-none';
  const drive = new FakeDrive();
  const svc = await startService(drive, [
    {
      id: 'channel-only',
      discord_guild_id: 'guild-x',
      discord_channel_ids: ['chan-yes'],
      caller: { token_sha256: sha256(TOKEN_X) },
      destination: { type: 'google-drive', folder_id: 'folder-x' },
    },
    {
      id: 'loud-no',
      discord_guild_id: 'guild-none',
      caller: { token_sha256: sha256(TOKEN_NONE) },
      destination: { type: 'none' },
    },
  ]);
  try {
    // A channel outside the tenant's list resolves to nothing, not to it.
    const wrong = await pollJob(
      svc.base,
      (
        await submitJob(svc.base, {
          origin: discordOrigin('guild-x', 'chan-no'),
          token: TOKEN_X,
        })
      ).body.job_id,
    );
    assert.equal(wrong.saved, undefined);

    const right = await pollJob(
      svc.base,
      (
        await submitJob(svc.base, {
          origin: discordOrigin('guild-x', 'chan-yes'),
          token: TOKEN_X,
        })
      ).body.job_id,
    );
    assert.equal(right.saved.url, 'https://drive.google.com/file/d/fake-drive-1/view');

    // A verified claim on a "none" destination saves nothing and is no error.
    const none = await pollJob(
      svc.base,
      (
        await submitJob(svc.base, {
          origin: discordOrigin('guild-none', 'chan-1'),
          token: TOKEN_NONE,
        })
      ).body.job_id,
    );
    assert.equal(none.saved, undefined);
    assert.equal(none.save_error, undefined);
    assert.equal(drive.filesIn('folder-x').length, 1);
    assert.equal(drive.files.length, 1);
  } finally {
    await svc.close();
  }
});

// --- F3: file preservation ---------------------------------------------------

// Two different videos whose titles slug to the same file name used to
// overwrite one another; identity is the video id, so both transcripts live.
test('F3: different videos with the same title keep both transcripts', async () => {
  const drive = new FakeDrive();
  const svc = await startService(drive, TENANTS_TWO, {
    metadata: async () => ({ title: 'Same title', channel: 'Test Channel' }),
  });
  try {
    for (const videoId of [VIDEO_A, VIDEO_B]) {
      const job = await pollJob(
        svc.base,
        (
          await submitJob(svc.base, {
            url: `https://youtu.be/${videoId}`,
            origin: discordOrigin('guild-a', 'chan-1'),
            token: TOKEN_A,
          })
        ).body.job_id,
      );
      assert.equal(job.status, 'done');
    }
    const files = drive.filesIn('folder-a');
    assert.equal(files.length, 2, 'both videos must be preserved');
    const byVideo = new Map(files.map((f) => [f.props.videoId, f]));
    assert.equal(byVideo.get(VIDEO_A)?.name, `same-title_${VIDEO_A}_20261122.txt`);
    assert.equal(byVideo.get(VIDEO_B)?.name, `same-title_${VIDEO_B}_20261122.txt`);
    assert.match(byVideo.get(VIDEO_A)?.content ?? '', new RegExp(`v=${VIDEO_A}`));
    assert.match(byVideo.get(VIDEO_B)?.content ?? '', new RegExp(`v=${VIDEO_B}`));
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

test('renderTranscriptFile: .md renders a heading, metadata list and block lines', () => {
  const url = `https://www.youtube.com/watch?v=${VIDEO_A}`;
  const out = renderTranscriptFile(
    {
      video_id: VIDEO_A,
      source_url: url,
      language: 'en',
      blocks: [
        { start: 0, end: 1.5, text: 'hello' },
        { start: 65, end: 72, text: 'world' },
      ],
    },
    META,
    '.md',
    FIXED_NOW,
  );
  assert.equal(
    out,
    [
      '# My Great Video!',
      '',
      '- Channel: Test Channel',
      `- Source: [${url}](${url})`,
      '- Captured: 2026-11-22',
      '- Language: en',
      '- Covered: 1:12',
      '',
      '**[0:00]** hello',
      '',
      '**[1:05]** world',
      '',
    ].join('\n'),
  );
});

test('resolveTenant: channel-scoped beats guild-wide; web origins resolve only via web_emails', () => {
  const tenants = [
    { id: 'guild-wide', discord_guild_id: 'g', destination: { type: 'none' as const } },
    {
      id: 'channel-scoped',
      discord_guild_id: 'g',
      discord_channel_ids: ['c1'],
      destination: { type: 'none' as const },
    },
    {
      id: 'web-tenant',
      web_emails: ['Alice@Example.com'],
      destination: { type: 'none' as const },
    },
  ];
  assert.equal(
    resolveTenant(tenants, { kind: 'discord', guild_id: 'g', channel_id: 'c1' })?.id,
    'channel-scoped',
  );
  assert.equal(
    resolveTenant(tenants, { kind: 'discord', guild_id: 'g', channel_id: 'c9' })?.id,
    'guild-wide',
  );
  // A web identity resolves only when a tenant allowlists it — and the
  // allowlist match is case-insensitive.
  assert.equal(resolveTenant(tenants, { kind: 'web', identity: 'alice@example.com' })?.id, 'web-tenant');
  assert.equal(resolveTenant(tenants, { kind: 'web', identity: 'ALICE@EXAMPLE.COM' })?.id, 'web-tenant');
  assert.equal(resolveTenant(tenants, { kind: 'web', identity: 'bob@example.com' }), undefined);
  assert.equal(resolveTenant(tenants, { kind: 'web', identity: 'w1' }), undefined);
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

  writeFileSync(file, JSON.stringify({ tenants: [{ id: 'x', gemini_key_env: '  ' }] }));
  assert.throws(() => loadTenantsFile(file), /gemini_key_env/);
});
