import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTranscriptSaver } from '../src/save.js';
import { parseDriveLink, type DriveStore } from '../src/drive.js';

// F3: file identity is tenant folder + appProperties.videoId only. A file
// whose display name matches but whose stored video id differs is never read,
// updated or renamed.
test('an existing file with a matching name but another video id survives untouched', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fa-preserve-'));
  const tenantsFile = join(dir, 'tenants.json');
  writeFileSync(
    tenantsFile,
    JSON.stringify({
      tenants: [{ id: 'a', discord_guild_id: 'guild-a', destination: { type: 'google-drive', folder_id: 'folder-a' } }],
    }),
  );
  interface F { id: string; folder: string; name: string; props: Record<string, string>; content: string; url: string }
  const original: F = {
    id: 'existing-file',
    folder: 'folder-a',
    name: 'same-title_hWe-j78vNpc_20261122.txt',
    props: { videoId: 'dQw4w9WgXcQ' },
    content: 'OTHER VIDEO MUST SURVIVE',
    url: 'https://drive.google.com/file/d/existing-file/view',
  };
  const files: F[] = [original];
  const updated: string[] = [];
  const drive: DriveStore = {
    async findFileByVideoId(folder, id) {
      return files.find((f) => f.folder === folder && f.props.videoId === id) ?? null;
    },
    async createFile(folder, name, content, _mime, props = {}) {
      const f = { id: 'new-file', folder, name, content, props, url: 'https://drive.google.com/file/d/new-file/view' };
      files.push(f);
      return f;
    },
    async updateFile(id, name, content) {
      updated.push(id);
      const f = files.find((x) => x.id === id);
      assert.ok(f);
      f.name = name;
      f.content = content;
      return { id: f.id, name: f.name };
    },
  };
  const save = createTranscriptSaver({
    tenantsFile,
    drive,
    metadata: async () => ({ title: 'Same title' }),
    now: () => new Date('2026-11-22'),
    log: () => {},
  });
  const saved = await save(
    { kind: 'discord', guild_id: 'guild-a', channel_id: 'channel-a' },
    {
      video_id: 'hWe-j78vNpc',
      source_url: 'https://www.youtube.com/watch?v=hWe-j78vNpc',
      language: 'en',
      blocks: [{ start: 0, end: 1, text: 'NEW VIDEO CONTENT' }],
    } as never,
  );
  assert.equal(original.content, 'OTHER VIDEO MUST SURVIVE');
  assert.equal(original.name, 'same-title_hWe-j78vNpc_20261122.txt');
  assert.deepEqual(updated, []);
  assert.equal(files.length, 2);
  assert.equal(saved?.url, parseDriveLink('https://drive.google.com/file/d/new-file/view'));
});
