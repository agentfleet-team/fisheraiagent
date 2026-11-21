import { ApiError, type TranscriptApi } from './api.js';
import { findYouTubeUrl } from './find-url.js';
import { transcriptToSrt, transcriptToTxt } from './format.js';
import { loggerFor, type LogCode } from '../log.js';
import { parseChannelId, parseGuildId, parseVideoId } from '../ids.js';
import { safeText, type SafeText } from '../safe-text.js';
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

// Text sent to a person takes only SafeText: a literal wrapped at its
// definition or an entry of the fixed error table. A plain `string` —
// caught text, a remote field, anything computed — does not fit.
export interface MessageSink {
  react(emoji: SafeText): Promise<void>;
  reply(content: SafeText, files: AttachmentFile[]): Promise<void>;
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

export interface BotDeps {
  api: TranscriptApi;
  store: GuildStore;
  log?: (line: string) => void;
}

export interface BotCore {
  handleMessage(msg: BotMessage, sink: MessageSink): Promise<void>;
  handleCommand(cmd: BotCommand, sink: CommandSink): Promise<void>;
}

type ErrorKey = Exclude<LogCode, 'usage'>;

const ERROR_MESSAGES: Record<ErrorKey, SafeText> = {
  invalid_url: safeText("That doesn't look like a usable YouTube link."),
  video_unavailable: safeText('This video is unavailable — it may be private, deleted, or blocked for transcription.'),
  missing_key: safeText('The service received no Gemini key. An admin can set one with `/transcript set-key`.'),
  key_rejected: safeText('The Gemini key set for this server was rejected. An admin can replace it with `/transcript set-key`.'),
  quota_exceeded: safeText("This server's Gemini key is out of quota. Try again later or set a different key."),
  upstream_timeout: safeText('Transcription timed out upstream. Try again.'),
  bad_model_output: safeText('The model returned unusable output. Try again.'),
  invalid_config: safeText('The transcript service is misconfigured.'),
  unauthorized: safeText("The transcript service rejected this bot's service token."),
  invalid_request: safeText('The transcript service rejected the request.'),
  not_found: safeText('The transcript service did not recognize that request.'),
  api_unreachable: safeText('The transcript service is unreachable. Try again later.'),
  job_lost: safeText('The transcript service restarted and lost the job. Try again.'),
  job_timeout: safeText('Timed out waiting for the transcript. Try again.'),
  internal_error: safeText('Something went wrong inside the transcript service. Try again.'),
};

// A code is logged or shown only when it maps to a fixed local message;
// anything else, including arbitrary remote text in an ApiError, folds
// into internal_error.
function errorCode(err: unknown): ErrorKey {
  const code = err instanceof ApiError ? err.code : 'internal_error';
  return isErrorKey(code) ? code : 'internal_error';
}

function isErrorKey(code: string): code is ErrorKey {
  return Object.hasOwn(ERROR_MESSAGES, code);
}

export function createBot(deps: BotDeps): BotCore {
  const log = loggerFor(deps.log);
  const { api, store } = deps;

  return {
    async handleCommand(cmd, sink) {
      if (!cmd.memberCanManageGuild) {
        await sink.replyEphemeral(
          safeText('You need the **Manage Server** permission to set up the transcript bot.'),
        );
        return;
      }
      switch (cmd.subcommand) {
        case 'set-key': {
          const key = cmd.key?.trim();
          if (!key) {
            await sink.replyEphemeral(safeText('Provide the Gemini API key: `/transcript set-key`.'));
            return;
          }
          store.setKey(cmd.guildId, key);
          log('key_set', { guild: parseGuildId(cmd.guildId) });
          await sink.replyEphemeral(
            safeText('Gemini key saved for this server. Enable a channel with `/transcript enable`.'),
          );
          return;
        }
        case 'remove-key': {
          store.removeKey(cmd.guildId);
          log('key_removed', { guild: parseGuildId(cmd.guildId) });
          await sink.replyEphemeral(safeText('Gemini key removed for this server.'));
          return;
        }
        case 'enable': {
          store.enableChannel(cmd.guildId, cmd.channelId);
          log('channel_enabled', { guild: parseGuildId(cmd.guildId), channel: parseChannelId(cmd.channelId) });
          await sink.replyEphemeral(
            safeText('Transcript bot enabled here. Post a YouTube link and the transcript lands in this channel or thread.'),
          );
          return;
        }
        case 'disable': {
          store.disableChannel(cmd.guildId, cmd.channelId);
          log('channel_disabled', { guild: parseGuildId(cmd.guildId), channel: parseChannelId(cmd.channelId) });
          await sink.replyEphemeral(safeText('Transcript bot disabled here.'));
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
      if (!ids.some((id) => store.isEnabled(msg.guildId, id))) return;

      const url = findYouTubeUrl(msg.content);
      if (!url) return;

      const apiKey = store.getKey(msg.guildId);
      if (!apiKey) {
        await sink.reply(
          safeText('No Gemini key is set for this server. A server admin can add one with `/transcript set-key`.'),
          [],
        );
        return;
      }

      try {
        await sink.react(safeText('⏳'));
      } catch {
        // The progress reaction is best-effort; missing permission must not stop the job.
      }

      log('job_submitted', { guild: parseGuildId(msg.guildId), channel: parseChannelId(msg.channelId) });
      try {
        const transcript = await api.transcribe(url, apiKey);
        // transcript.video_id is remote data: validate before it logs as an id.
        log('job_done', {
          guild: parseGuildId(msg.guildId),
          channel: parseChannelId(msg.channelId),
          video: parseVideoId(transcript.video_id),
        });
        // The reply text is fixed; the transcript itself rides in the two
        // attachments (its id is in the file names, url and language in the .txt).
        await sink.reply(safeText('Transcript ready — the .txt and .srt files are attached.'), [
          { name: `${transcript.video_id}.txt`, data: transcriptToTxt(transcript) },
          { name: `${transcript.video_id}.srt`, data: transcriptToSrt(transcript) },
        ]);
      } catch (err) {
        const code = errorCode(err);
        log('job_failed', { guild: parseGuildId(msg.guildId), channel: parseChannelId(msg.channelId), code });
        await sink.reply(ERROR_MESSAGES[code], []);
      }
    },
  };
}
