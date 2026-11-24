import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createService, type ServiceOptions } from '../src/service.js';
import { createDiscordApi } from '../src/deliver.js';
import { TranscriptError } from '../src/errors.js';
import type { GeminiCaller, GeminiVideoRequest } from '../src/gemini.js';
import type { DriveStore } from '../src/drive.js';
import { parseTenantsJson } from '../src/tenants.js';

// allen-ai-os#1506: service-side Discord delivery. A verified tenant caller
// names `deliver_to`; the service resolves the target through Discord,
// posts one bounded summary plus the `.txt` attachment, or one short line
// with the fixed error code, and reports it in the job view's `delivery`.
// The fake Discord runs through the real createDiscordApi client, so the
// tests also pin down https-only, no-redirects and the bearer header.

const GOOD = readFileSync(new URL('./fixtures/model-good.txt', import.meta.url), 'utf8');
const VIDEO_A = 'hWe-j78vNpc';
const KEY_A = 'TEST-KEY-ALPHA-x9x9x9';
const CALLER_TOKEN = 'test-caller-token-delivery';
const DELIVER_TOKEN_ENV = 'FA_TEST_DELIVERER_TOKEN';
const DELIVER_TOKEN = 'test-file-deliverer-token-z3z3';
const GEMINI_KEY_ENV = 'FA_TEST_FLEET_GEMINI_KEY';
const TENANT_KEY = 'TEST-KEY-FLEET-k2k2k2';
const GUILD = '1563234143804981340';
const CHAN = '1567766696058421400';
const CHAN_TWO = '1567766696058421401';
const THREAD = '1567766696058421402';
const OUTSIDE = '1567766696058421403';

const sha256 = (token: string): string => createHash('sha256').update(token).digest('hex');

interface GeminiCall {
  apiKey: string;
  req: GeminiVideoRequest;
}

const caller: GeminiCaller = async (req) => ({
  text: (req.startOffsetSeconds ?? 0) > 0 ? 'LANGUAGE: en' : GOOD,
  status: 'completed',
});

// --- fake Discord ----------------------------------------------------------

interface DiscordRequest {
  url: string;
  init: RequestInit;
}

interface DiscordPost {
  channelId: string;
  payload: { content?: string };
  file?: { name: string; data: string; type: string };
}

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

// Serves GET /api/v10/channels/{id} and POST .../messages over the real
// client; every request is recorded so tests can assert the URL, the
// redirect mode and the bearer header.
class FakeDiscord {
  readonly requests: DiscordRequest[] = [];
  readonly posts: DiscordPost[] = [];
  readonly channels = new Map<string, { id: string; guild_id?: string; parent_id?: string }>();
  failPost?: number;
  redirectTo?: string;

  readonly fetchImpl: typeof fetch = async (input, init) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    this.requests.push({ url, init: init ?? {} });
    if (this.redirectTo !== undefined) {
      return new Response(null, { status: 302, headers: { location: this.redirectTo } });
    }
    const path = new URL(url).pathname;
    const postMatch = /^\/api\/v10\/channels\/([^/]+)\/messages$/.exec(path);
    if (postMatch) {
      if (this.failPost !== undefined) {
        return new Response('server error', { status: this.failPost });
      }
      const form = init?.body instanceof FormData ? init.body : undefined;
      const raw = form?.get('payload_json');
      const payload = typeof raw === 'string' ? JSON.parse(raw) : {};
      const upload = form?.get('files[0]');
      const file =
        upload instanceof File
          ? { name: upload.name, data: await upload.text(), type: upload.type }
          : undefined;
      const id = `discord-msg-${this.posts.length + 1}`;
      this.posts.push({ channelId: decodeURIComponent(postMatch[1]), payload, file });
      return jsonResponse({ id });
    }
    const chanMatch = /^\/api\/v10\/channels\/([^/]+)$/.exec(path);
    if (chanMatch) {
      const channel = this.channels.get(decodeURIComponent(chanMatch[1]));
      return channel === undefined ? new Response('not found', { status: 404 }) : jsonResponse(channel);
    }
    return new Response('not found', { status: 404 });
  };
}

// --- fake Drive ------------------------------------------------------------

class FakeDrive implements DriveStore {
  readonly files: { id: string; name: string; content: string; url: string; props: Record<string, string> }[] = [];
  private seq = 0;

  async findFileByVideoId(folderId: string, videoId: string) {
    return (
      this.files.filter((f) => f.props.videoId === videoId)[0] ?? null
    );
  }

  async createFile(
    folderId: string,
    name: string,
    content: string,
    _mimeType?: string,
    appProperties: Record<string, string> = {},
  ) {
    const file = {
      id: `fake-drive-${++this.seq}`,
      folder: folderId,
      name,
      content,
      url: `https://drive.google.com/file/d/fake-drive-${this.seq}/view`,
      props: appProperties,
    };
    this.files.push(file);
    return { id: file.id, name };
  }

  async updateFile(fileId: string, name: string, content: string) {
    const file = this.files.find((f) => f.id === fileId);
    assert.ok(file, `update for unknown file ${fileId}`);
    file.name = name;
    file.content = content;
    return { id: file.id, name: file.name };
  }
}

// --- harness ---------------------------------------------------------------

interface RunningService {
  base: string;
  logs: string[];
  usedKeys: string[];
  close: () => Promise<void>;
}

function startService(
  discord: FakeDiscord,
  tenants: unknown,
  overrides: Partial<ServiceOptions> = {},
): Promise<RunningService> {
  const logs: string[] = [];
  const usedKeys: string[] = [];
  const server: Server = createService({
    callerFactory: (apiKey) => {
      usedKeys.push(apiKey);
      return caller;
    },
    model: 'test-model',
    maxBlockSeconds: 8,
    cacheDir: mkdtempSync(join(tmpdir(), 'fa-deliver-cache-')),
    tenantsJson: JSON.stringify({ tenants }),
    discordApi: (token) => createDiscordApi({ token, fetchImpl: discord.fetchImpl }),
    drive: overrides.drive,
    videoMetadata: async () => ({ title: 'My Great Video!', channel: 'Test Channel' }),
    log: (line) => logs.push(line),
    ...overrides,
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        base: `http://127.0.0.1:${port}`,
        logs,
        usedKeys,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}

interface HttpResult {
  status: number;
  body: any;
}

async function postJob(
  base: string,
  opts: { url?: string; key?: string; token?: string; origin?: unknown; deliverTo?: unknown } = {},
): Promise<HttpResult> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.key !== undefined) headers['x-gemini-key'] = opts.key;
  if (opts.token !== undefined) headers['authorization'] = `Bearer ${opts.token}`;
  const res = await fetch(`${base}/v1/jobs`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      url: opts.url ?? `https://youtu.be/${VIDEO_A}`,
      ...(opts.origin !== undefined ? { origin: opts.origin } : {}),
      ...(opts.deliverTo !== undefined ? { deliver_to: opts.deliverTo } : {}),
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

const ORIGIN = { kind: 'discord', guild_id: GUILD, channel_id: CHAN };

function tenantWithDelivery(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'fleet',
    discord_guild_id: GUILD,
    discord_channel_ids: [CHAN],
    caller: { token_sha256: sha256(CALLER_TOKEN) },
    gemini_key_env: GEMINI_KEY_ENV,
    discord_delivery: { token_env: DELIVER_TOKEN_ENV },
    destination: { type: 'google-drive', folder_id: 'folder-fleet' },
    ...extra,
  };
}

// The production shape: the tenant holds both the Gemini key and the
// delivery token, referenced by env var name; the caller sends neither.
function setTenantEnv(): void {
  process.env[DELIVER_TOKEN_ENV] = DELIVER_TOKEN;
  process.env[GEMINI_KEY_ENV] = TENANT_KEY;
}

function clearTenantEnv(): void {
  delete process.env[DELIVER_TOKEN_ENV];
  delete process.env[GEMINI_KEY_ENV];
}

function channelInGuild(id: string, parent?: string): { id: string; guild_id: string; parent_id?: string } {
  const channel = { id, guild_id: GUILD };
  return parent === undefined ? channel : { ...channel, parent_id: parent };
}

// --- tests -----------------------------------------------------------------

test('D1: a verified caller gets the summary, the .txt and the Drive link in the target', async () => {
  const discord = new FakeDiscord();
  discord.channels.set(CHAN, channelInGuild(CHAN));
  const drive = new FakeDrive();
  setTenantEnv();
  const svc = await startService(discord, [tenantWithDelivery()], { drive });
  try {
    const res = await postJob(svc.base, { origin: ORIGIN, token: CALLER_TOKEN, deliverTo: CHAN });
    assert.equal(res.status, 202);
    const job = await pollJob(svc.base, res.body.job_id);
    assert.equal(job.status, 'done');
    assert.deepEqual(job.delivery, { status: 'sent', message_id: 'discord-msg-1' });
    // The caller sent no key: the job ran on the tenant's own key.
    assert.deepEqual([...new Set(svc.usedKeys)], [TENANT_KEY]);

    // Drive save is unchanged and still happened.
    assert.equal(job.saved.type, 'google-drive');
    assert.equal(drive.files.length, 1);

    // One bounded message into the named channel, transcript attached.
    assert.equal(discord.posts.length, 1);
    const post = discord.posts[0];
    assert.equal(post.channelId, CHAN);
    assert.ok(typeof post.payload.content === 'string');
    assert.ok(post.payload.content!.length <= 2000);
    assert.match(post.payload.content!, /Language: en — 0:39 covered/);
    assert.match(post.payload.content!, /Saved to Drive: https:\/\/drive\.google\.com\/file\/d\/fake-drive-1\/view/);
    assert.match(post.payload.content!, /technique that I use all the time/);
    assert.equal(post.file?.name, `${VIDEO_A}.txt`);
    assert.match(post.file?.data ?? '', /Transcript: https:\/\/www\.youtube\.com\/watch\?v=/);

    // The token went only to discord.com over https, bearer header, no
    // redirects followed — and nowhere near the logs or the job view.
    assert.ok(discord.requests.length >= 2);
    for (const req of discord.requests) {
      assert.ok(req.url.startsWith('https://discord.com/api/v10/'), req.url);
      assert.equal(req.init.redirect, 'manual');
      assert.equal(
        (req.init.headers as Record<string, string>).authorization,
        `Bot ${DELIVER_TOKEN}`,
      );
    }
    const haystack = `${svc.logs.join('\n')}\n${JSON.stringify(job)}`;
    assert.ok(!haystack.includes(DELIVER_TOKEN), `delivery token leaked: ${haystack}`);
    assert.ok(svc.logs.some((line) => line.includes('delivery_sent')), svc.logs.join('\n'));
  } finally {
    clearTenantEnv();
    await svc.close();
  }
});

test('D2: a thread target is accepted through its parent channel', async () => {
  const discord = new FakeDiscord();
  discord.channels.set(THREAD, channelInGuild(THREAD, CHAN));
  const drive = new FakeDrive();
  setTenantEnv();
  const svc = await startService(discord, [tenantWithDelivery()], { drive });
  try {
    const res = await postJob(svc.base, { origin: ORIGIN, token: CALLER_TOKEN, deliverTo: THREAD });
    assert.equal(res.status, 202);
    const job = await pollJob(svc.base, res.body.job_id);
    assert.equal(job.status, 'done');
    assert.equal(job.delivery.status, 'sent');
    assert.equal(discord.posts[0].channelId, THREAD);
  } finally {
    clearTenantEnv();
    await svc.close();
  }
});

test('D3: a target outside the tenant channels is refused and nothing is posted', async () => {
  const discord = new FakeDiscord();
  // The channel exists — Discord just does not report it under the tenant's
  // configured ids (and a thread whose parent is a stranger is refused too).
  discord.channels.set(OUTSIDE, channelInGuild(OUTSIDE));
  discord.channels.set(THREAD, channelInGuild(THREAD, OUTSIDE));
  const drive = new FakeDrive();
  setTenantEnv();
  const svc = await startService(discord, [tenantWithDelivery()], { drive });
  try {
    for (const target of [OUTSIDE, THREAD]) {
      const res = await postJob(svc.base, {
        origin: ORIGIN,
        token: CALLER_TOKEN,
        deliverTo: target,
      });
      assert.equal(res.status, 202);
      const job = await pollJob(svc.base, res.body.job_id);
      assert.equal(job.status, 'done');
      assert.ok(job.result, 'the transcript is still returned');
      assert.equal(job.delivery.status, 'failed');
      assert.equal(job.delivery.code, 'delivery_refused');
    }
    assert.equal(discord.posts.length, 0, 'nothing must be posted');
    // The transcript and the Drive save still succeeded for both jobs.
    assert.equal(drive.files.length, 1, 'same video converges to one file');
  } finally {
    clearTenantEnv();
    await svc.close();
  }
});

test('D4: an unauthenticated deliver_to is ignored — no lookup, no post', async () => {
  const discord = new FakeDiscord();
  const drive = new FakeDrive();
  setTenantEnv();
  const svc = await startService(
    discord,
    [
      tenantWithDelivery(),
      {
        id: 'plain',
        discord_guild_id: '1563234143804981341',
        discord_channel_ids: [CHAN_TWO],
        caller: { token_sha256: sha256(CALLER_TOKEN) },
        destination: { type: 'google-drive', folder_id: 'folder-plain' },
      },
    ],
    { drive },
  );
  try {
    // No bearer at all: the origin claim is denied, deliver_to ignored.
    const noToken = await postJob(svc.base, { key: KEY_A, origin: ORIGIN, deliverTo: CHAN });
    assert.equal(noToken.status, 202);
    const jobA = await pollJob(svc.base, noToken.body.job_id);
    assert.equal(jobA.status, 'done');
    assert.equal(jobA.delivery, undefined);
    assert.equal(jobA.save_error.code, 'save_unauthorized');

    // A wrong caller credential: same denial.
    const wrong = await postJob(svc.base, {
      key: KEY_A,
      origin: ORIGIN,
      token: 'wrong-token',
      deliverTo: CHAN,
    });
    const jobB = await pollJob(svc.base, wrong.body.job_id);
    assert.equal(jobB.delivery, undefined);

    // No origin claim: nothing resolves, deliver_to ignored.
    const noOrigin = await postJob(svc.base, { key: KEY_A, deliverTo: CHAN });
    const jobC = await pollJob(svc.base, noOrigin.body.job_id);
    assert.equal(jobC.delivery, undefined);

    // A verified caller of a tenant with no discord_delivery: ignored.
    const plain = await postJob(svc.base, {
      key: KEY_A,
      origin: { kind: 'discord', guild_id: '1563234143804981341', channel_id: CHAN_TWO },
      token: CALLER_TOKEN,
      deliverTo: CHAN_TWO,
    });
    const jobD = await pollJob(svc.base, plain.body.job_id);
    assert.equal(jobD.delivery, undefined);

    assert.equal(discord.requests.length, 0, 'Discord must not be touched');
    assert.equal(discord.posts.length, 0);
  } finally {
    clearTenantEnv();
    await svc.close();
  }
});

test('D5: a Discord failure reports delivery.failed while transcript and save still land', async () => {
  const discord = new FakeDiscord();
  discord.channels.set(CHAN, channelInGuild(CHAN));
  discord.failPost = 500;
  const drive = new FakeDrive();
  setTenantEnv();
  const svc = await startService(discord, [tenantWithDelivery()], { drive });
  try {
    const res = await postJob(svc.base, { origin: ORIGIN, token: CALLER_TOKEN, deliverTo: CHAN });
    const job = await pollJob(svc.base, res.body.job_id);
    assert.equal(job.status, 'done');
    assert.ok(job.result);
    assert.equal(job.saved.type, 'google-drive');
    assert.equal(drive.files.length, 1);
    assert.equal(job.delivery.status, 'failed');
    assert.equal(job.delivery.code, 'delivery_failed');
    assert.ok(svc.logs.some((line) => line.includes('delivery_failed')));
  } finally {
    clearTenantEnv();
    await svc.close();
  }
});

test('D6: a failed job posts one short line with the fixed code', async () => {
  const discord = new FakeDiscord();
  discord.channels.set(CHAN, channelInGuild(CHAN));
  setTenantEnv();
  const failing: GeminiCaller = async () => {
    throw new TranscriptError('video_unavailable', 'offline double');
  };
  const svc = await startService(discord, [tenantWithDelivery()], {
    callerFactory: () => failing,
  });
  try {
    const res = await postJob(svc.base, { origin: ORIGIN, token: CALLER_TOKEN, deliverTo: CHAN });
    const job = await pollJob(svc.base, res.body.job_id);
    assert.equal(job.status, 'failed');
    assert.equal(job.error.code, 'video_unavailable');
    assert.equal(job.delivery.status, 'sent');
    assert.equal(discord.posts.length, 1);
    assert.equal(discord.posts[0].payload.content, 'Transcript failed: video_unavailable');
    assert.equal(discord.posts[0].file, undefined, 'a failure line carries no attachment');
  } finally {
    clearTenantEnv();
    await svc.close();
  }
});

test('D7: an unset delivery token reports invalid_config and posts nothing', async () => {
  const discord = new FakeDiscord();
  discord.channels.set(CHAN, channelInGuild(CHAN));
  process.env[GEMINI_KEY_ENV] = TENANT_KEY;
  delete process.env[DELIVER_TOKEN_ENV];
  const svc = await startService(discord, [tenantWithDelivery()]);
  try {
    const res = await postJob(svc.base, { origin: ORIGIN, token: CALLER_TOKEN, deliverTo: CHAN });
    const job = await pollJob(svc.base, res.body.job_id);
    assert.equal(job.status, 'done');
    assert.equal(job.delivery.status, 'failed');
    assert.equal(job.delivery.code, 'invalid_config');
    assert.equal(discord.requests.length, 0, 'Discord must not be called without a token');
  } finally {
    clearTenantEnv();
    await svc.close();
  }
});

test('D8: a Discord redirect is a failure, never followed', async () => {
  const discord = new FakeDiscord();
  discord.redirectTo = 'http://169.254.169.254/latest/meta-data';
  setTenantEnv();
  const svc = await startService(discord, [tenantWithDelivery()]);
  try {
    const res = await postJob(svc.base, { origin: ORIGIN, token: CALLER_TOKEN, deliverTo: CHAN });
    const job = await pollJob(svc.base, res.body.job_id);
    assert.equal(job.delivery.status, 'failed');
    assert.equal(job.delivery.code, 'delivery_failed');
    for (const req of discord.requests) {
      assert.ok(req.url.startsWith('https://discord.com/'), req.url);
    }
    assert.equal(discord.posts.length, 0);
  } finally {
    clearTenantEnv();
    await svc.close();
  }
});

test('D9: a malformed deliver_to is a 400 and no job is created', async () => {
  const discord = new FakeDiscord();
  setTenantEnv();
  const svc = await startService(discord, [tenantWithDelivery()]);
  try {
    for (const bad of ['not-a-snowflake', 12345, { id: CHAN }]) {
      const res = await postJob(svc.base, {
        origin: ORIGIN,
        token: CALLER_TOKEN,
        deliverTo: bad,
      });
      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, 'invalid_request');
    }
  } finally {
    clearTenantEnv();
    await svc.close();
  }
});

test('D10: the tenants document rejects a malformed discord_delivery', () => {
  assert.throws(
    () =>
      parseTenantsJson(
        JSON.stringify({ tenants: [{ id: 'x', discord_delivery: {} }] }),
        'test',
      ),
    /token_env/,
  );
  assert.throws(
    () =>
      parseTenantsJson(
        JSON.stringify({ tenants: [{ id: 'x', discord_delivery: 'yes' }] }),
        'test',
      ),
    /discord_delivery/,
  );
});

test('D11: delivery waits on the job view — done already carries delivery', async () => {
  const discord = new FakeDiscord();
  discord.channels.set(CHAN, channelInGuild(CHAN));
  setTenantEnv();
  const svc = await startService(discord, [tenantWithDelivery()]);
  try {
    const res = await postJob(svc.base, { origin: ORIGIN, token: CALLER_TOKEN, deliverTo: CHAN });
    const job = await pollJob(svc.base, res.body.job_id);
    // pollJob returns on the first terminal status: delivery must already
    // be populated — a racing poller can never see done without it.
    assert.equal(job.status, 'done');
    assert.equal(job.delivery.status, 'sent');
  } finally {
    clearTenantEnv();
    await svc.close();
  }
});

test('D12: a long transcript keeps the source, metadata and Drive link in the bounded summary', async () => {
  const discord = new FakeDiscord();
  discord.channels.set(CHAN, channelInGuild(CHAN));
  const drive = new FakeDrive();
  setTenantEnv();
  const longCaller: GeminiCaller = async (req) => ({
    text:
      (req.startOffsetSeconds ?? 0) > 0
        ? 'LANGUAGE: en'
        : `DURATION: 8.0\nLANGUAGE: en\n[00:00 - 00:08] ${'x'.repeat(2200)}`,
    status: 'completed',
  });
  const svc = await startService(discord, [tenantWithDelivery()], {
    drive,
    callerFactory: () => longCaller,
  });
  try {
    const res = await postJob(svc.base, { origin: ORIGIN, token: CALLER_TOKEN, deliverTo: CHAN });
    assert.equal(res.status, 202);
    const job = await pollJob(svc.base, res.body.job_id);
    assert.equal(job.status, 'done');
    assert.equal(job.delivery.status, 'sent');
    assert.equal(job.saved.type, 'google-drive');
    assert.equal(drive.files.length, 1);

    assert.equal(discord.posts.length, 1);
    const content = discord.posts[0].payload.content!;
    assert.ok(content.length <= 2000, `summary exceeds the cap: ${content.length}`);
    assert.match(content, /Transcript: https:\/\/www\.youtube\.com\/watch\?v=/);
    assert.match(content, /Language: en — 0:08 covered/);
    assert.match(content, /Saved to Drive: https:\/\/drive\.google\.com\/file\/d\/fake-drive-1\/view/);
    // The excerpt is what gave way — bounded, never the saved link.
    assert.equal(discord.posts[0].file?.name, `${VIDEO_A}.txt`);
  } finally {
    clearTenantEnv();
    await svc.close();
  }
});

test('D13: a .md tenant gets a Markdown file in Drive and a .md attachment in Discord', async () => {
  const discord = new FakeDiscord();
  discord.channels.set(CHAN, channelInGuild(CHAN));
  const drive = new FakeDrive();
  setTenantEnv();
  const svc = await startService(
    discord,
    [
      tenantWithDelivery({
        destination: { type: 'google-drive', folder_id: 'folder-fleet', extension: '.md' },
      }),
    ],
    {
      drive,
      now: () => new Date('2026-11-22T03:00:00Z'),
    },
  );
  try {
    const res = await postJob(svc.base, { origin: ORIGIN, token: CALLER_TOKEN, deliverTo: CHAN });
    assert.equal(res.status, 202);
    const job = await pollJob(svc.base, res.body.job_id);
    assert.equal(job.status, 'done');
    assert.equal(job.delivery.status, 'sent');

    assert.equal(drive.files.length, 1);
    const driveFile = drive.files[0];
    assert.equal(driveFile.name, `my-great-video_${VIDEO_A}_20261122.md`);
    const url = `https://www.youtube.com/watch?v=${VIDEO_A}`;
    assert.match(driveFile.content, /^# My Great Video!\n\n- Channel: Test Channel\n/);
    assert.ok(driveFile.content.includes(`- Source: [${url}](${url})\n`));
    assert.ok(driveFile.content.includes('- Captured: 2026-11-22\n'));
    assert.ok(driveFile.content.includes('- Language: en\n'));
    assert.ok(driveFile.content.includes('- Covered: 0:39\n'));
    assert.match(driveFile.content, /\n\n\*\*\[0:00\]\*\* [^\n]+\n\n\*\*\[0:07\]\*\* /);

    assert.equal(discord.posts.length, 1);
    const post = discord.posts[0];
    assert.match(
      post.payload.content ?? '',
      /Saved to Drive: https:\/\/drive\.google\.com\/file\/d\/fake-drive-1\/view/,
    );
    assert.equal(post.file?.name, `${VIDEO_A}.md`);
    assert.equal(post.file?.type, 'text/markdown');
    assert.equal(post.file?.data, driveFile.content);
  } finally {
    clearTenantEnv();
    await svc.close();
  }
});
