import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createService, type ServiceOptions } from '../src/service.js';
import { TranscriptError } from '../src/errors.js';
import type { GeminiCaller } from '../src/gemini.js';
import { createApiClient, type TranscriptApi } from '../src/bot/api.js';
import type { BotConfig } from '../src/bot/config.js';
import { createBot, type AttachmentFile, type BotMessage, type MessageSink } from '../src/bot/core.js';
import { startDiscordBot } from '../src/bot/discord.js';
import { Client, Events } from 'discord.js';
import { deriveEncryptionKey, decryptSecret, type KeyRecord } from '../src/bot/crypto.js';
import { GuildStore } from '../src/bot/store.js';
import { transcriptToSrt, formatDuration } from '../src/bot/format.js';

const GOOD = readFileSync(new URL('./fixtures/model-good.txt', import.meta.url), 'utf8');
const GUILD = 'guild-1';
const CHANNEL = 'channel-1';
const THREAD = 'thread-1';
const OTHER_CHANNEL = 'channel-2';
const GUILD_KEY = 'TEST-GUILD-GEMINI-KEY-7f3a9c';
const ENC_SECRET = 'test-encryption-secret';
const VIDEO_URL = 'https://youtu.be/hWe-j78vNpc';
const VIDEO_ID = 'hWe-j78vNpc';

// --- API test double: the real #2 service with a fake Gemini caller ---------

interface ApiDouble {
  base: string;
  calls: number;
  logs: string[];
  close: () => Promise<void>;
}

async function startApiDouble(opts: { failWith?: unknown } = {}): Promise<ApiDouble> {
  const state = { calls: 0, logs: [] as string[] };
  const caller: GeminiCaller = async () => {
    state.calls += 1;
    if (opts.failWith) throw opts.failWith;
    return { text: GOOD, status: 'completed' };
  };
  const options: ServiceOptions = {
    callerFactory: () => caller,
    model: 'test-model',
    maxBlockSeconds: 8,
    cacheDir: mkdtempSync(join(tmpdir(), 'fa-bot-cache-')),
    log: (line) => state.logs.push(line),
  };
  const server: Server = createService(options);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    get calls() {
      return state.calls;
    },
    logs: state.logs,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function apiClient(double: ApiDouble): TranscriptApi {
  return createApiClient({ baseUrl: double.base, pollIntervalMs: 5, timeoutMs: 10_000 });
}

// --- Fake Discord side ------------------------------------------------------

interface RecordedReply {
  targetId: string;
  content: string;
  files: AttachmentFile[];
}

interface FakeDiscord {
  sink: MessageSink;
  reactions: { targetId: string; emoji: string }[];
  replies: RecordedReply[];
  ephemeral: string[];
}

function fakeDiscord(targetId: string): FakeDiscord {
  const fake: FakeDiscord = {
    reactions: [],
    replies: [],
    ephemeral: [],
    sink: {
      react: async (emoji) => {
        fake.reactions.push({ targetId, emoji });
      },
      reply: async (content, files) => {
        fake.replies.push({ targetId, content, files });
      },
    },
  };
  return fake;
}

function makeStore() {
  const dir = mkdtempSync(join(tmpdir(), 'fa-bot-data-'));
  const file = join(dir, 'bot-data.json');
  return { file, store: new GuildStore(file, deriveEncryptionKey(ENC_SECRET)) };
}

function threadMessage(overrides: Partial<BotMessage> = {}): BotMessage {
  return {
    guildId: GUILD,
    channelId: THREAD,
    parentChannelId: CHANNEL,
    authorIsBot: false,
    content: `check this ${VIDEO_URL}`,
    ...overrides,
  };
}

// --- D1: same thread reply --------------------------------------------------

test('D1: a URL posted in a thread of an enabled channel gets the reply and two attachments in that thread', async () => {
  const api = await startApiDouble();
  try {
    const { store } = makeStore();
    store.setKey(GUILD, GUILD_KEY);
    store.enableChannel(GUILD, CHANNEL);
    const logs: string[] = [];
    const core = createBot({ api: apiClient(api), store, log: (l) => logs.push(l) });
    const discord = fakeDiscord(THREAD);

    await core.handleMessage(threadMessage(), discord.sink);

    assert.equal(api.calls, 1);
    assert.deepEqual(discord.reactions, [{ targetId: THREAD, emoji: '⏳' }]);
    assert.equal(discord.replies.length, 1);
    const reply = discord.replies[0];
    assert.equal(reply.targetId, THREAD);
    // The reply text is fixed; the video id reaches the user through the
    // attachment file names and the .txt header.
    assert.match(reply.files[0].name, new RegExp(VIDEO_ID));
    assert.equal(reply.files.length, 2);
    assert.match(reply.files[0].name, /\.txt$/);
    assert.match(reply.files[1].name, /\.srt$/);
    assert.match(reply.files[0].data, /Transcript:/);
    assert.match(reply.files[1].data, /-->/);
  } finally {
    await api.close();
  }
});

test('D1b: a URL posted in an enabled channel (no thread) gets the reply in that channel', async () => {
  const api = await startApiDouble();
  try {
    const { store } = makeStore();
    store.setKey(GUILD, GUILD_KEY);
    store.enableChannel(GUILD, CHANNEL);
    const core = createBot({ api: apiClient(api), store });
    const discord = fakeDiscord(CHANNEL);

    await core.handleMessage(
      threadMessage({ channelId: CHANNEL, parentChannelId: undefined }),
      discord.sink,
    );

    assert.equal(api.calls, 1);
    assert.equal(discord.replies.length, 1);
    assert.equal(discord.replies[0].targetId, CHANNEL);
  } finally {
    await api.close();
  }
});

// --- D2: ignored channel ----------------------------------------------------

test('D2: a URL in a channel that is not enabled is ignored — no API call, no reply', async () => {
  const api = await startApiDouble();
  try {
    const { store } = makeStore();
    store.setKey(GUILD, GUILD_KEY);
    store.enableChannel(GUILD, CHANNEL);
    const core = createBot({ api: apiClient(api), store });
    const discord = fakeDiscord(OTHER_CHANNEL);

    await core.handleMessage(
      threadMessage({ channelId: OTHER_CHANNEL, parentChannelId: undefined }),
      discord.sink,
    );
    // A thread under a channel that was never enabled is also ignored.
    await core.handleMessage(
      threadMessage({ channelId: 'thread-9', parentChannelId: OTHER_CHANNEL }),
      discord.sink,
    );
    // A message without a YouTube URL in an enabled channel is ignored too.
    await core.handleMessage(threadMessage({ content: 'hello everyone' }), discord.sink);

    assert.equal(api.calls, 0);
    assert.equal(discord.replies.length, 0);
    assert.equal(discord.reactions.length, 0);
  } finally {
    await api.close();
  }
});

// --- D3: admin only ---------------------------------------------------------

test('D3: a setup command from a member without Manage Server is refused ephemerally; nothing stored', async () => {
  const { store } = makeStore();
  const api = await startApiDouble();
  try {
    const core = createBot({ api: apiClient(api), store });
    const discord = fakeDiscord(CHANNEL);

    for (const subcommand of ['set-key', 'remove-key', 'enable', 'disable'] as const) {
      await core.handleCommand(
        {
          guildId: GUILD,
          channelId: CHANNEL,
          memberCanManageGuild: false,
          subcommand,
          key: subcommand === 'set-key' ? GUILD_KEY : undefined,
        },
        { replyEphemeral: async (c) => { discord.ephemeral.push(c); } },
      );
    }

    assert.equal(discord.ephemeral.length, 4);
    assert.match(discord.ephemeral[0], /Manage Server/i);
    assert.equal(store.getKey(GUILD), undefined);
    assert.equal(store.isEnabled(GUILD, CHANNEL), false);
  } finally {
    await api.close();
  }
});

// --- D4: key removal --------------------------------------------------------

test('D4: after remove-key, posting a URL replies that no key is set; no API call', async () => {
  const api = await startApiDouble();
  try {
    const { store } = makeStore();
    store.setKey(GUILD, GUILD_KEY);
    store.enableChannel(GUILD, CHANNEL);
    const core = createBot({ api: apiClient(api), store });
    const discord = fakeDiscord(CHANNEL);

    await core.handleCommand(
      { guildId: GUILD, channelId: CHANNEL, memberCanManageGuild: true, subcommand: 'remove-key' },
      { replyEphemeral: async (c) => { discord.ephemeral.push(c); } },
    );
    await core.handleMessage(
      threadMessage({ channelId: CHANNEL, parentChannelId: undefined }),
      discord.sink,
    );

    assert.equal(api.calls, 0);
    assert.equal(discord.replies.length, 1);
    assert.match(discord.replies[0].content, /no gemini key is set/i);
    assert.equal(discord.replies[0].targetId, CHANNEL);
  } finally {
    await api.close();
  }
});

// --- D5: encrypted at rest --------------------------------------------------

test('D5: the stored guild key is ciphertext, and decrypts back under BOT_ENCRYPTION_KEY', async () => {
  const { file, store } = makeStore();
  const api = await startApiDouble();
  try {
    const core = createBot({ api: apiClient(api), store });
    const discord = fakeDiscord(CHANNEL);

    await core.handleCommand(
      {
        guildId: GUILD,
        channelId: CHANNEL,
        memberCanManageGuild: true,
        subcommand: 'set-key',
        key: GUILD_KEY,
      },
      { replyEphemeral: async (c) => { discord.ephemeral.push(c); } },
    );

    const raw = readFileSync(file, 'utf8');
    assert.ok(!raw.includes(GUILD_KEY), 'plaintext key must not appear in the storage file');
    const parsed = JSON.parse(raw) as { guilds: Record<string, { key?: KeyRecord }> };
    const record = parsed.guilds[GUILD]?.key;
    assert.ok(record?.data && record.iv && record.tag, 'ciphertext record must be present');
    assert.equal(decryptSecret(record, deriveEncryptionKey(ENC_SECRET)), GUILD_KEY);
  } finally {
    await api.close();
  }
});

// --- D6: key never logged ---------------------------------------------------

test('D6: no log line, reply, or ephemeral message ever contains the guild key', async () => {
  const api = await startApiDouble();
  try {
    const { store } = makeStore();
    const logs: string[] = [];
    const core = createBot({ api: apiClient(api), store, log: (l) => logs.push(l) });
    const discord = fakeDiscord(CHANNEL);

    await core.handleCommand(
      { guildId: GUILD, channelId: CHANNEL, memberCanManageGuild: true, subcommand: 'set-key', key: GUILD_KEY },
      { replyEphemeral: async (c) => { discord.ephemeral.push(c); } },
    );
    await core.handleCommand(
      { guildId: GUILD, channelId: CHANNEL, memberCanManageGuild: true, subcommand: 'enable' },
      { replyEphemeral: async (c) => { discord.ephemeral.push(c); } },
    );
    await core.handleMessage(
      threadMessage({ channelId: CHANNEL, parentChannelId: undefined }),
      discord.sink,
    );
    await core.handleCommand(
      { guildId: GUILD, channelId: CHANNEL, memberCanManageGuild: true, subcommand: 'remove-key' },
      { replyEphemeral: async (c) => { discord.ephemeral.push(c); } },
    );

    for (const line of [...logs, ...api.logs]) {
      assert.ok(!line.includes(GUILD_KEY), `log line leaked the key: ${line}`);
    }
    for (const reply of [...discord.ephemeral, ...discord.replies.map((r) => r.content)]) {
      assert.ok(!reply.includes(GUILD_KEY), `reply leaked the key: ${reply}`);
    }
  } finally {
    await api.close();
  }
});

// --- D7: error reply --------------------------------------------------------

test('D7: a video_unavailable failure is mapped and posted in the same thread', async () => {
  const api = await startApiDouble({
    failWith: new TranscriptError('video_unavailable', 'video is unavailable'),
  });
  try {
    const { store } = makeStore();
    store.setKey(GUILD, GUILD_KEY);
    store.enableChannel(GUILD, CHANNEL);
    const core = createBot({ api: apiClient(api), store });
    const discord = fakeDiscord(THREAD);

    await core.handleMessage(threadMessage(), discord.sink);

    assert.equal(discord.replies.length, 1);
    assert.equal(discord.replies[0].targetId, THREAD);
    assert.match(discord.replies[0].content, /unavailable/i);
    assert.equal(discord.replies[0].files.length, 0);
  } finally {
    await api.close();
  }
});

// --- F1: untrusted remote error codes ---------------------------------------

test('F1: a remote error code outside the contract never reaches logs or Discord replies', async () => {
  const CANARY = 'FAKE-REMOTE-CODE-DO-NOT-EXPOSE';
  const api = createApiClient({
    baseUrl: 'http://offline.invalid',
    fetchImpl: async () =>
      new Response(JSON.stringify({ error: { code: CANARY, message: CANARY } }), { status: 400 }),
  });
  const { store } = makeStore();
  store.setKey(GUILD, GUILD_KEY);
  store.enableChannel(GUILD, CHANNEL);
  const logs: string[] = [];
  const core = createBot({ api, store, log: (l) => logs.push(l) });
  const discord = fakeDiscord(CHANNEL);

  await core.handleMessage(
    threadMessage({ channelId: CHANNEL, parentChannelId: undefined }),
    discord.sink,
  );

  assert.equal(discord.replies.length, 1);
  for (const line of logs) assert.ok(!line.includes(CANARY), `log leaked remote text: ${line}`);
  for (const reply of discord.replies) {
    assert.ok(!reply.content.includes(CANARY), `reply leaked remote text: ${reply.content}`);
  }
});

test('F1b: a failed job maps contract codes and folds unknown ones to the fixed error', async () => {
  const failingJob = (code: string) => {
    let submitted = false;
    return createApiClient({
      baseUrl: 'http://offline.invalid',
      fetchImpl: async () => {
        if (!submitted) {
          submitted = true;
          return new Response(JSON.stringify({ job_id: 'job-1' }), { status: 202 });
        }
        return new Response(
          JSON.stringify({ job_id: 'job-1', status: 'failed', error: { code, message: 'remote text' } }),
          { status: 200 },
        );
      },
    });
  };
  const { store } = makeStore();
  store.setKey(GUILD, GUILD_KEY);
  store.enableChannel(GUILD, CHANNEL);
  const msg = () => threadMessage({ channelId: CHANNEL, parentChannelId: undefined });

  const CANARY = 'FAKE-TOKEN-TEXT-DO-NOT-EXPOSE';
  const logs: string[] = [];
  const unknown = fakeDiscord(CHANNEL);
  await createBot({ api: failingJob(CANARY), store, log: (l) => logs.push(l) }).handleMessage(
    msg(),
    unknown.sink,
  );
  assert.match(unknown.replies[0].content, /something went wrong/i);
  for (const line of logs) assert.ok(!line.includes(CANARY), `log leaked remote text: ${line}`);
  assert.ok(!unknown.replies[0].content.includes(CANARY));

  const known = fakeDiscord(CHANNEL);
  await createBot({ api: failingJob('video_unavailable'), store }).handleMessage(msg(), known.sink);
  assert.match(known.replies[0].content, /unavailable/i);
});

// --- F2: the adapter never reads content in a disabled channel --------------

test('F2: the adapter does not read message content until the channel allowlist passes', async () => {
  const api = await startApiDouble();
  const originalLogin = Client.prototype.login;
  Client.prototype.login = async function () {
    return 'offline';
  };
  try {
    const { file, store } = makeStore();
    store.setKey(GUILD, GUILD_KEY);
    store.enableChannel(GUILD, CHANNEL);
    const core = createBot({ api: apiClient(api), store });
    const config: BotConfig = {
      discordToken: 'FAKE-NOT-LIVE',
      encryptionSecret: 'unused',
      apiBaseUrl: api.base,
      dataFile: file,
      pollIntervalMs: 5,
      jobTimeoutMs: 10_000,
    };
    const client = await startDiscordBot(config, core, () => {});

    let reads = 0;
    let sends = 0;
    const fakeMessage = (channelId: string, parentId?: string) => ({
      guildId: GUILD,
      channelId,
      channel: {
        isThread: () => parentId !== undefined,
        parentId,
        send: async () => {
          sends += 1;
        },
      },
      author: { bot: false },
      get content() {
        reads += 1;
        return `private text ${VIDEO_URL}`;
      },
    });

    // A disabled channel and a thread under a disabled channel: the core
    // must return before any content access.
    client.emit(Events.MessageCreate, fakeMessage(OTHER_CHANNEL));
    client.emit(Events.MessageCreate, fakeMessage('thread-9', OTHER_CHANNEL));
    await new Promise((r) => setImmediate(r));

    assert.equal(reads, 0);
    assert.equal(sends, 0);
    assert.equal(api.calls, 0);

    // In an enabled channel the lazy content is read once and the transcript
    // reply is sent through the originating channel.
    const sent: { content?: string; files?: { name: string }[] }[] = [];
    client.emit(Events.MessageCreate, {
      ...fakeMessage(CHANNEL),
      channel: {
        isThread: () => false,
        send: async (payload: { content?: string; files?: { name: string }[] }) => {
          sent.push(payload);
        },
      },
      react: async () => {},
    });
    const deadline = Date.now() + 10_000;
    while (sent.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 5));
    }

    assert.equal(reads, 1);
    assert.equal(sent.length, 1);
    assert.deepEqual(
      sent[0].files?.map((f) => f.name.split('.').pop()),
      ['txt', 'srt'],
    );
    await client.destroy();
  } finally {
    Client.prototype.login = originalLogin;
    await api.close();
  }
});

// --- D8: documented invite permissions ---------------------------------------

test('D8: the documented invite permissions cover every action the bot takes', () => {
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  const line = readme.split('\n').find((l) => l.includes('bot permissions'));
  assert.ok(line, 'README must document the invite bot permissions');
  for (const permission of [
    'View Channel',
    'Send Messages',
    'Send Messages in Threads',
    'Attach Files',
    'Add Reactions',
    'Read Message History',
  ]) {
    assert.ok(line.includes(permission), `invite permissions must include ${permission}`);
  }
});

// --- format helpers ---------------------------------------------------------

test('format helpers: duration and srt timestamps', () => {
  assert.equal(formatDuration(62), '1:02');
  assert.equal(formatDuration(3661), '1:01:01');
  const srt = transcriptToSrt({
    video_id: VIDEO_ID,
    source_url: 'https://www.youtube.com/watch?v=hWe-j78vNpc',
    language: 'en',
    blocks: [
      { start: 0, end: 1.5, text: 'hello' },
      { start: 1.5, end: 3, text: 'world' },
    ],
  });
  assert.match(srt, /1\n00:00:00,000 --> 00:00:01,500\nhello/);
  assert.match(srt, /2\n00:00:01,500 --> 00:00:03,000\nworld/);
});
