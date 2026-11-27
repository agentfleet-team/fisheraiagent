import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadServiceConfig } from '../src/config.js';
import type { DigestLlm } from '../src/digest/llm.js';
import { createDigestService } from '../src/digest/service.js';
import { createDriveStore } from '../src/drive.js';
import type { DriveStore, StoredFile } from '../src/drive.js';
import { namedFileDrive, saveDriveFromConfig } from '../src/drive-save.js';
import type { EngineResult, VoiceEngine } from '../src/voice/engine.js';
import { createVoiceService } from '../src/voice/service.js';

const fixtures = (dir: string, name: string): string =>
  readFileSync(join(import.meta.dirname, 'fixtures', dir, name), 'utf8');

// An in-memory DriveStore that counts creates. No network, no real folder id.
class FakeStore implements DriveStore {
  readonly files: { id: string; folder: string; name: string; content: string | Buffer; props?: Record<string, string> }[] = [];
  creates = 0;
  async findFileByVideoId(folderId: string, videoId: string): Promise<StoredFile | null> {
    const f = this.files.find((x) => x.folder === folderId && x.props?.videoId === videoId);
    return f === undefined ? null : { id: f.id, name: f.name };
  }
  async createFile(folderId: string, name: string, content: string | Buffer, _mime: string, props?: Record<string, string>) {
    this.creates += 1;
    const f = { id: `fake-${this.files.length + 1}`, folder: folderId, name, content, props };
    this.files.push(f);
    return { id: f.id, name };
  }
  async updateFile(): Promise<StoredFile> {
    throw new Error('a save node never updates a file');
  }
}

async function withServer<T>(server: Server, fn: (base: string) => Promise<T>): Promise<T> {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  try {
    return await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
}

async function run(base: string, body: unknown, headers: Record<string, string>): Promise<Record<string, any>> {
  const res = await fetch(`${base}/v1/jobs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const { job_id } = (await res.json()) as { job_id: string };
  for (let i = 0; i < 300; i++) {
    const view = (await (await fetch(`${base}/v1/jobs/${job_id}`)).json()) as Record<string, any>;
    if (view.status === 'done' || view.status === 'failed') return view;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('job did not settle');
}

const tenantsJson = JSON.stringify({
  tenants: [
    {
      id: 'tenant-x',
      caller: { token_env: 'DRIVE_SAVE_TEST_TOKEN' },
      gemini_key_env: 'DRIVE_SAVE_TEST_GEMINI',
      destination: { type: 'google-drive', folder_id: 'fake-folder-1' },
    },
  ],
});
const noDestination = JSON.stringify({ tenants: [{ id: 'tenant-y', caller: { token_env: 'DRIVE_SAVE_TEST_TOKEN' } }] });

function withEnv<T>(fn: () => Promise<T>): Promise<T> {
  process.env.DRIVE_SAVE_TEST_TOKEN = 'tok';
  process.env.DRIVE_SAVE_TEST_GEMINI = 'gem';
  return fn().finally(() => {
    delete process.env.DRIVE_SAVE_TEST_TOKEN;
    delete process.env.DRIVE_SAVE_TEST_GEMINI;
  });
}

const llm: DigestLlm = async () => fixtures('digest', 'model-good.json');
// 200 ms of audio per character at 48 kbit/s, which is what the duration check reads.
const engine: VoiceEngine = async ({ text }): Promise<EngineResult> => {
  const ms = [...text].length * 200;
  return { audio: Buffer.alloc(ms * 6, 1), sentences: [{ text, offset_ms: 0, duration_ms: ms }] };
};
const auth = { authorization: 'Bearer tok' };
const digestBody: unknown = JSON.parse(fixtures('digest', 'request.json'));
const voiceBody: unknown = JSON.parse(fixtures('voice', 'request.json'));

test('W1: the adapter exists with each of the three credential variables, and not with none', () => {
  const seen: Record<string, unknown>[] = [];
  const makeStore = ((options: Record<string, unknown>) => {
    seen.push(options);
    return new FakeStore();
  }) as unknown as typeof createDriveStore;
  for (const env of [
    { GOOGLE_APPLICATION_CREDENTIALS: 'a-path' },
    { GOOGLE_CREDENTIALS_JSON: '{}' },
    { GOOGLE_OAUTH_JSON: '{}' },
  ]) {
    assert.ok(saveDriveFromConfig(loadServiceConfig(env), makeStore));
  }
  assert.equal(seen.length, 3);
  assert.equal(seen[0].credentialsPath, 'a-path');
  assert.equal(seen[1].credentialsJson, '{}');
  assert.equal(seen[2].oauthJson, '{}');
  assert.equal(saveDriveFromConfig(loadServiceConfig({}), makeStore), undefined);
  assert.equal(seen.length, 3);
});

test('W1: with no credential variable no drive is passed and the job result has no saved', async () => {
  await withEnv(async () => {
    const drive = saveDriveFromConfig(loadServiceConfig({}));
    assert.equal(drive, undefined);
    const server = createDigestService({ llmFactory: () => llm, drive, tenantsJson });
    await withServer(server, async (base) => {
      const view = await run(base, digestBody, { ...auth, 'x-gemini-key': '' });
      assert.equal(view.status, 'done');
      assert.equal(view.result.saved, undefined);
    });
  });
});

test('W2/W3: a digest job saves <date>-script.md; a second job creates nothing and returns the same id', async () => {
  await withEnv(async () => {
    const store = new FakeStore();
    const server = createDigestService({ llmFactory: () => llm, drive: namedFileDrive(store), tenantsJson });
    await withServer(server, async (base) => {
      const first = await run(base, digestBody, { ...auth, 'x-gemini-key': '' });
      assert.equal(first.status, 'done');
      assert.deepEqual(first.result.saved, { file_id: 'fake-1', name: '2026-11-28-script.md' });
      assert.equal(store.creates, 1);
      assert.equal(store.files[0].folder, 'fake-folder-1');
      assert.equal(store.files[0].content, first.result.markdown);
      const second = await run(base, digestBody, { ...auth, 'x-gemini-key': '' });
      assert.deepEqual(second.result.saved, first.result.saved);
      assert.equal(store.creates, 1);
    });
  });
});

test('W2/W3: a voice job saves audio and marks with their bytes; a second job creates nothing', async () => {
  await withEnv(async () => {
    const store = new FakeStore();
    const server = createVoiceService({ engine, drive: namedFileDrive(store), tenantsJson });
    await withServer(server, async (base) => {
      const first = await run(base, voiceBody, auth);
      assert.equal(first.status, 'done');
      assert.deepEqual(first.result.saved, {
        audio_file_id: 'fake-1',
        marks_file_id: 'fake-2',
        names: ['2026-11-28-episode.mp3', '2026-11-28-marks.json'],
      });
      assert.equal(store.creates, 2);
      assert.ok(Buffer.isBuffer(store.files[0].content));
      const second = await run(base, voiceBody, auth);
      assert.deepEqual(second.result.saved, first.result.saved);
      assert.equal(store.creates, 2);
    });
  });
});

test('W2: a tenant with no google-drive destination gets no saved and no create', async () => {
  await withEnv(async () => {
    const store = new FakeStore();
    const server = createVoiceService({ engine, drive: namedFileDrive(store), tenantsJson: noDestination });
    await withServer(server, async (base) => {
      const view = await run(base, voiceBody, auth);
      assert.equal(view.status, 'done');
      assert.equal(view.result.saved, undefined);
      assert.equal(store.creates, 0);
    });
  });
});

test('the adapter keys a file by its name, never by a video id', async () => {
  const store = new FakeStore();
  await store.createFile('f', 'clip.txt', 'x', 'text/plain', { videoId: 'hWe-j78vNpc' });
  const drive = namedFileDrive(store);
  assert.equal(await drive.findFileByName('f', '2026-11-28-script.md'), null);
  const made = await drive.createFile('f', '2026-11-28-script.md', 'y', 'text/markdown');
  assert.deepEqual(await drive.findFileByName('f', '2026-11-28-script.md'), made);
});

test('Drive upload keeps binary content byte for byte', async () => {
  const audio = Buffer.from([0xff, 0xfb, 0x90, 0x00, 0x80, 0xc3, 0x28]);
  let body: Uint8Array | undefined;
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).startsWith('https://oauth2.googleapis.com/token')) {
      return new Response(JSON.stringify({ access_token: 't', expires_in: 3600 }));
    }
    body = init?.body as Uint8Array;
    return new Response(JSON.stringify({ id: 'fake-9', name: 'a.mp3' }));
  }) as typeof fetch;
  const store = createDriveStore({
    oauthJson: JSON.stringify({ client_id: 'c', client_secret: 's', refresh_token: 'r' }),
    fetchImpl,
  });
  await store.createFile('fake-folder-1', 'a.mp3', audio, 'audio/mpeg');
  assert.ok(body !== undefined && Buffer.from(body).includes(audio));
});
