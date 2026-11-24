import { ApiError, type SavedLink, type TranscriptApi } from './api.js';
import { findYouTubeUrl } from './find-url.js';
import { transcriptToSrt, transcriptToTxt } from './format.js';
import { loggerFor, type LogCode } from '../log.js';
import { parseChannelId, parseGuildId, parseVideoId } from '../ids.js';
import { hasMessage, safeText, type MessageCode, type SafeText } from '../safe-text.js';
import type { GuildStore } from './store.js';

// Discord-free core: the adapter in discord.js land translates events into
// these plain shapes, and the tests drive the same shapes with fakes. Ids
// are re-validated by the parse functions where they are logged.

export interface BotMessage {
  guildId: string;
  channelId: string; // where the message landed; a thread id for thread messages
  parentChannelId?: string; // set when channelId is a thread
  authorIsBot: boolean;
  content: string;
}

export interface AttachmentFile {
  name: string;
  data: string;
}

// Text sent to a person takes only SafeText: an entry of the fixed
// code-to-message table. A plain `string` — caught text, a remote field,
// anything computed — does not fit, and no function turns one into
// SafeText. `link` is structured data like the attachments: a saved-file
// link that passed the API client's shape check, rendered by the adapter.
export interface MessageSink {
  react(emoji: SafeText): Promise<void>;
  reply(content: SafeText, files: AttachmentFile[], link?: SavedLink): Promise<void>;
}

export type BotSubcommand = 'set-key' | 'remove-key' | 'enable' | 'disable';

const BOT_SUBCOMMANDS: readonly BotSubcommand[] = ['set-key', 'remove-key', 'enable', 'disable'];

export function isBotSubcommand(value: string): value is BotSubcommand {
  return BOT_SUBCOMMANDS.some((s) => s === value);
}

export interface BotCommand {
  guildId: string;
  channelId: string; // channel or thread the setup command was run in
  memberCanManageGuild: boolean;
  subcommand: BotSubcommand;
  key?: string;
}

export interface CommandSink {
  replyEphemeral(content: SafeText): Promise<void>;
}

// The channels a tenant listener answers in: the tenant's guild and its
// configured channel ids (a thread is covered through its parent channel),
// all from configuration — no per-guild key, no data file.
export interface TenantChannels {
  guildId: string;
  channelIds: readonly string[];
}

export type BotDeps = {
  api: TranscriptApi;
  log?: (line: string) => void;
} & ({ store: GuildStore } | { tenant: TenantChannels });

export interface BotCore {
  handleMessage(msg: BotMessage, sink: MessageSink): Promise<void>;
  handleCommand(cmd: BotCommand, sink: CommandSink): Promise<void>;
}

// Only a LogCode with a 'bot.error.<code>' entry in the messages table can
// become an error reply; 'usage' and save-path codes have no such entry.
type WithBotError<Code> = Code extends string
  ? `bot.error.${Code}` extends MessageCode
    ? Code
    : never
  : never;
type ErrorKey = WithBotError<Exclude<LogCode, 'usage'>>;

// A code is logged or shown only when it maps to a fixed table entry (the
// 'bot.error.<code>' messages); anything else, including arbitrary remote
// text in an ApiError, folds into internal_error.
function errorCode(err: unknown): ErrorKey {
  const code = err instanceof ApiError ? err.code : 'internal_error';
  return isErrorKey(code) ? code : 'internal_error';
}

function isErrorKey(code: string): code is ErrorKey {
  return hasMessage(`bot.error.${code}`);
}

export function createBot(deps: BotDeps): BotCore {
  const log = loggerFor(deps.log);
  const { api } = deps;
  const tenant = 'tenant' in deps ? deps.tenant : undefined;
  const store = 'store' in deps ? deps.store : undefined;

  return {
    async handleCommand(cmd, sink) {
      // Tenant mode registers no slash commands — there is nothing to set up.
      if (store === undefined) return;
      if (!cmd.memberCanManageGuild) {
        await sink.replyEphemeral(safeText('bot.need_manage_server'));
        return;
      }
      switch (cmd.subcommand) {
        case 'set-key': {
          const key = cmd.key?.trim();
          if (!key) {
            await sink.replyEphemeral(safeText('bot.key_prompt'));
            return;
          }
          store.setKey(cmd.guildId, key);
          log('key_set', { guild: parseGuildId(cmd.guildId) });
          await sink.replyEphemeral(safeText('bot.key_saved'));
          return;
        }
        case 'remove-key': {
          store.removeKey(cmd.guildId);
          log('key_removed', { guild: parseGuildId(cmd.guildId) });
          await sink.replyEphemeral(safeText('bot.key_removed'));
          return;
        }
        case 'enable': {
          store.enableChannel(cmd.guildId, cmd.channelId);
          log('channel_enabled', { guild: parseGuildId(cmd.guildId), channel: parseChannelId(cmd.channelId) });
          await sink.replyEphemeral(safeText('bot.enabled'));
          return;
        }
        case 'disable': {
          store.disableChannel(cmd.guildId, cmd.channelId);
          log('channel_disabled', { guild: parseGuildId(cmd.guildId), channel: parseChannelId(cmd.channelId) });
          await sink.replyEphemeral(safeText('bot.disabled'));
          return;
        }
      }
    },

    async handleMessage(msg, sink) {
      if (msg.authorIsBot || !msg.guildId) return;

      // Enablement is decided on channel metadata alone: the bot never looks
      // at message content in a channel or thread that is not enabled.
      // A thread is enabled by itself or through its parent channel.
      const ids = msg.parentChannelId ? [msg.channelId, msg.parentChannelId] : [msg.channelId];

      // Tenant listener mode: forward the URL and stop. The service owns the
      // transcript, the save and the delivery; the bot posts no message and
      // adds no reaction itself.
      if (tenant !== undefined) {
        if (msg.guildId !== tenant.guildId) return;
        if (!ids.some((id) => tenant.channelIds.includes(id))) return;
        const url = findYouTubeUrl(msg.content);
        if (!url) return;
        const fields = {
          guild: parseGuildId(msg.guildId),
          channel: parseChannelId(msg.channelId),
        };
        log('job_submitted', fields);
        try {
          await api.submit(url, {
            origin: {
              kind: 'discord',
              guild_id: msg.guildId,
              channel_id: msg.parentChannelId ?? msg.channelId,
            },
            deliverTo: msg.channelId,
          });
        } catch (err) {
          log('job_failed', { ...fields, code: errorCode(err) });
        }
        return;
      }

      if (store === undefined || !ids.some((id) => store.isEnabled(msg.guildId, id))) return;

      const url = findYouTubeUrl(msg.content);
      if (!url) return;

      const apiKey = store.getKey(msg.guildId);
      if (!apiKey) {
        await sink.reply(safeText('bot.no_key'), []);
        return;
      }

      try {
        await sink.react(safeText('bot.react_pending'));
      } catch {
        // The progress reaction is best-effort; missing permission must not stop the job.
      }

      log('job_submitted', { guild: parseGuildId(msg.guildId), channel: parseChannelId(msg.channelId) });
      try {
        const outcome = await api.transcribe(url, apiKey, {
          kind: 'discord',
          guild_id: msg.guildId,
          channel_id: msg.parentChannelId ?? msg.channelId,
        });
        const transcript = outcome.transcript;
        // transcript.video_id is remote data: validate before it logs as an id.
        log('job_done', {
          guild: parseGuildId(msg.guildId),
          channel: parseChannelId(msg.channelId),
          video: parseVideoId(transcript.video_id),
        });
        // The reply text is fixed; the transcript itself rides in the two
        // attachments (its id is in the file names, url and language in the
        // .txt). A saved-file link rides as validated structured data.
        const files = [
          { name: `${transcript.video_id}.txt`, data: transcriptToTxt(transcript) },
          { name: `${transcript.video_id}.srt`, data: transcriptToSrt(transcript) },
        ];
        if (outcome.saveErrorCode !== undefined) {
          await sink.reply(safeText('bot.transcript_save_failed'), files);
        } else {
          await sink.reply(safeText('bot.transcript_ready'), files, outcome.saved);
        }
      } catch (err) {
        const code = errorCode(err);
        log('job_failed', { guild: parseGuildId(msg.guildId), channel: parseChannelId(msg.channelId), code });
        await sink.reply(safeText(`bot.error.${code}`), []);
      }
    },
  };
}
