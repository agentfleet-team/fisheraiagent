import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { decryptSecret, encryptSecret, type KeyRecord } from './crypto.js';

interface StoredGuild {
  key?: KeyRecord;
  enabledChannels?: string[];
}

interface BotData {
  guilds: Record<string, StoredGuild>;
}

// One JSON file of per-guild settings: the encrypted Gemini key and the
// channel/thread ids the bot answers in. The decrypted key exists only in
// memory between getKey and the API call that uses it.
export class GuildStore {
  private readonly data: BotData;

  constructor(
    private readonly filePath: string,
    private readonly encryptionKey: Buffer,
  ) {
    this.data = this.load();
  }

  private load(): BotData {
    try {
      const parsed: BotData = JSON.parse(readFileSync(this.filePath, 'utf8'));
      if (parsed && typeof parsed === 'object' && parsed.guilds) return parsed;
    } catch {
      // Missing or corrupt file starts empty.
    }
    return { guilds: {} };
  }

  private save(): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    renameSync(tmp, this.filePath);
  }

  private guild(guildId: string): StoredGuild {
    return (this.data.guilds[guildId] ??= {});
  }

  setKey(guildId: string, plaintextKey: string): void {
    this.guild(guildId).key = encryptSecret(plaintextKey, this.encryptionKey);
    this.save();
  }

  getKey(guildId: string): string | undefined {
    const record = this.guild(guildId).key;
    return record ? decryptSecret(record, this.encryptionKey) : undefined;
  }

  removeKey(guildId: string): boolean {
    const guild = this.guild(guildId);
    const had = guild.key !== undefined;
    delete guild.key;
    this.save();
    return had;
  }

  enableChannel(guildId: string, channelId: string): void {
    const guild = this.guild(guildId);
    guild.enabledChannels ??= [];
    if (!guild.enabledChannels.includes(channelId)) guild.enabledChannels.push(channelId);
    this.save();
  }

  disableChannel(guildId: string, channelId: string): void {
    const guild = this.guild(guildId);
    guild.enabledChannels = (guild.enabledChannels ?? []).filter((id) => id !== channelId);
    this.save();
  }

  isEnabled(guildId: string, channelId: string): boolean {
    return (this.data.guilds[guildId]?.enabledChannels ?? []).includes(channelId);
  }
}
