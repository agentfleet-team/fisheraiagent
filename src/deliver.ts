import { messageForCode } from './errors.js';
import { formatDuration, transcriptToTxt } from './bot/format.js';
import { parseVideoId, type ChannelId } from './ids.js';
import type { DeliveryOutcome, DeliveryView } from './jobs.js';
import { loggerFor, type LogFields, type LogSink } from './log.js';
import type { SavedFile } from './save.js';
import { resolveTenant, type JobOrigin, type Tenant } from './tenants.js';

// Service-side Discord delivery: after a job settles, the service posts its
// outcome into the Discord channel or thread the verified caller named,
// using the tenant's own file-deliverer bot token. The caller's bot never
// holds a Discord token — it only names the target.

const DISCORD_API = 'https://discord.com/api/v10';
// Discord message content is capped at 2000 characters.
const MAX_MESSAGE_CHARS = 2000;
// How many transcript lines the summary shows before the attachment carries
// the rest.
const FIRST_LINES = 3;

export class DiscordError extends Error {
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'DiscordError';
    this.status = status;
  }
}

// What GET /channels/{id} tells the deliverer about a target: a thread
// reports its parent channel, a top-level channel reports none.
export interface DiscordChannel {
  id: string;
  guild_id?: string;
  parent_id?: string;
}

export interface DiscordAttachment {
  name: string;
  data: string;
}

// The Discord surface the deliverer needs, kept this small so the tests run
// a full fake offline.
export interface DiscordApi {
  // Resolves to the channel's shape, or undefined when Discord reports no
  // such channel — an unknowable target is refused, never posted into.
  channel(channelId: string): Promise<DiscordChannel | undefined>;
  // Posts one message with an optional file; resolves to the message id.
  postMessage(
    channelId: string,
    content: string,
    attachment?: DiscordAttachment,
  ): Promise<string>;
}

export type DiscordApiFactory = (token: string) => DiscordApi;

// Remote JSON is unknown until checked; this narrows fields by name so no
// unchecked `as` stands between the wire and the code.
function field(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null && key in value
    ? Reflect.get(value, key)
    : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

// The real REST client. https://discord.com only — the base URL is a
// constant, and every request passes `redirect: 'manual'` so a redirect is
// a failure, never followed: the bot token rides only the first request to
// the fixed Discord host. The token lives in the Authorization header for
// the lifetime of one call and is never part of a log line or an error.
export function createDiscordApi(options: {
  token: string;
  fetchImpl?: typeof fetch;
}): DiscordApi {
  const doFetch = options.fetchImpl ?? fetch;

  const request = async (path: string, init: RequestInit): Promise<Response> => {
    let res: Response;
    try {
      res = await doFetch(`${DISCORD_API}${path}`, {
        ...init,
        redirect: 'manual',
        headers: { authorization: `Bot ${options.token}`, ...(init.headers ?? {}) },
      });
    } catch {
      throw new DiscordError('Discord API unreachable');
    }
    return res;
  };

  return {
    async channel(channelId) {
      const res = await request(`/channels/${encodeURIComponent(channelId)}`, {});
      if (res.status === 404) return undefined;
      if (!res.ok) throw new DiscordError(`Discord API error ${res.status}`, res.status);
      const body: unknown = await res.json();
      const channel: DiscordChannel = { id: str(field(body, 'id')) ?? channelId };
      const guild = str(field(body, 'guild_id'));
      const parent = str(field(body, 'parent_id'));
      if (guild !== undefined) channel.guild_id = guild;
      if (parent !== undefined) channel.parent_id = parent;
      return channel;
    },

    async postMessage(channelId, content, attachment) {
      const form = new FormData();
      // allowed_mentions.parse = [] turns every mention in the posted text
      // into plain text: remote transcript lines can never ping anyone.
      form.set(
        'payload_json',
        JSON.stringify({ content, allowed_mentions: { parse: [] } }),
      );
      if (attachment !== undefined) {
        form.set(
          'files[0]',
          new Blob([attachment.data], { type: 'text/plain' }),
          attachment.name,
        );
      }
      const res = await request(`/channels/${encodeURIComponent(channelId)}/messages`, {
        method: 'POST',
        body: form,
      });
      if (!res.ok) throw new DiscordError(`Discord API error ${res.status}`, res.status);
      const body: unknown = await res.json();
      const id = str(field(body, 'id'));
      if (id === undefined) throw new DiscordError('Discord returned no message id');
      return id;
    },
  };
}

// Discord's 2000-character cap counts UTF-16 code units; stepping by code
// point keeps a surrogate pair whole instead of cutting one in half.
function bound(text: string, max: number): string {
  if (text.length <= max) return text;
  let out = '';
  for (const ch of text) {
    if (out.length + ch.length > max - 1) break;
    out += ch;
  }
  return `${out}…`;
}

function savedLine(saved: SavedFile | undefined): string | undefined {
  if (saved === undefined) return undefined;
  return saved.type === 'google-drive'
    ? `Saved to Drive: ${saved.url}`
    : `Saved to NAS: ${saved.path}`;
}

// The message plus attachment a settled job becomes. A done job gets one
// bounded summary — language, covered length and the first transcript
// lines, with the Drive link when the transcript was saved — and the full
// `.txt` attached; a failed job gets one short line carrying the fixed
// error code. Transcript text reaches the message as ordinary post text
// (the same text the attachment always carried), bounded, whitespace-
// collapsed and posted with all mentions disabled.
function renderDelivery(outcome: DeliveryOutcome): {
  content: string;
  attachment?: DiscordAttachment;
} {
  const transcript = outcome.transcript;
  if (transcript === undefined || outcome.error !== undefined) {
    const code = outcome.error?.code ?? 'internal_error';
    return { content: `Transcript failed: ${code}` };
  }
  const covered = transcript.blocks.reduce((max, b) => Math.max(max, b.end), 0);
  // The source, metadata and saved-link lines always survive the cap: only
  // the transcript excerpt is bounded, to whatever room they leave.
  const head = [
    `Transcript: ${transcript.source_url}`,
    `Language: ${transcript.language} — ${formatDuration(covered)} covered`,
  ];
  const excerptLines: string[] = [];
  for (const block of transcript.blocks.slice(0, FIRST_LINES)) {
    const text = block.text.replace(/\s+/g, ' ').trim();
    if (text !== '') excerptLines.push(`- ${text}`);
  }
  const link = savedLine(outcome.saved);
  const fixed = [...head, ...(link === undefined ? [] : [link])].join('\n');
  // The excerpt sits between head and link, so it pays for its own leading
  // separator; the head-to-link separator already counts in `fixed`.
  const excerptBudget =
    excerptLines.length === 0 ? 0 : MAX_MESSAGE_CHARS - fixed.length - 1;
  const excerpt =
    excerptBudget >= 1 ? bound(excerptLines.join('\n'), excerptBudget) : '';
  const parts = [head.join('\n')];
  if (excerpt !== '') parts.push(excerpt);
  if (link !== undefined) parts.push(link);
  return {
    content: parts.join('\n'),
    attachment: { name: `${transcript.video_id}.txt`, data: transcriptToTxt(transcript) },
  };
}

export interface DelivererDeps {
  // The tenants document source — the same loader the saver uses, re-read
  // so a config edit takes effect without a restart.
  loadTenants: () => Tenant[];
  // Builds the Discord client from the tenant's delivery token; tests
  // inject a fake. Unset means the real discord.com REST client.
  discord?: DiscordApiFactory;
  log?: LogSink;
}

// Returns the after-job hook the runner calls once an outcome exists for a
// job whose verified caller named `deliverTo`. The origin is an already-
// authenticated claim. The post goes out only when the resolved tenant
// still has discord_delivery and Discord reports the target — or a
// thread's parent — among that tenant's configured channel ids; anything
// else is delivery_refused with nothing posted. Every failure is reported
// in the view as delivery.failed with a fixed code, never thrown text.
export function createTranscriptDeliverer(
  deps: DelivererDeps,
): (origin: JobOrigin, deliverTo: ChannelId, outcome: DeliveryOutcome) => Promise<DeliveryView | undefined> {
  const log = loggerFor(deps.log);
  const discord = deps.discord ?? ((token: string) => createDiscordApi({ token }));
  const failed = (code: 'delivery_failed' | 'delivery_refused' | 'invalid_config'): DeliveryView => ({
    status: 'failed',
    code,
    message: messageForCode(code),
  });
  return async (origin, deliverTo, outcome) => {
    const tenant = resolveTenant(deps.loadTenants(), origin);
    const fields: LogFields = { tenant: tenant?.id, channel: deliverTo };
    const token = (process.env[tenant?.discord_delivery?.token_env ?? ''] ?? '').trim();
    if (tenant === undefined || tenant.discord_delivery === undefined || token === '') {
      // A target the boundary accepted for a tenant that cannot deliver
      // (no delivery block, or an unset token variable): nothing is
      // posted, and the view reports the config gap honestly.
      log('delivery_failed', { ...fields, code: 'invalid_config' });
      return failed('invalid_config');
    }
    const api = discord(token);
    let target: DiscordChannel | undefined;
    try {
      target = await api.channel(deliverTo);
    } catch {
      log('delivery_failed', { ...fields, code: 'delivery_failed' });
      return failed('delivery_failed');
    }
    // Discord, not the request, says what the target is: a channel is
    // accepted by its own id, a thread by its parent channel's id — and
    // either must sit in the tenant's guild when the tenant names one.
    const channels = tenant.discord_channel_ids ?? [];
    const inChannels =
      target !== undefined &&
      (channels.includes(deliverTo) ||
        (target.parent_id !== undefined && channels.includes(target.parent_id)));
    const inGuild =
      tenant.discord_guild_id === undefined || target?.guild_id === tenant.discord_guild_id;
    if (!inChannels || !inGuild) {
      log('delivery_failed', { ...fields, code: 'delivery_refused' });
      return failed('delivery_refused');
    }
    const { content, attachment } = renderDelivery(outcome);
    try {
      const message_id = await api.postMessage(deliverTo, content, attachment);
      log('delivery_sent', {
        ...fields,
        video: outcome.transcript === undefined ? undefined : parseVideoId(outcome.transcript.video_id),
      });
      return { status: 'sent', message_id };
    } catch {
      log('delivery_failed', { ...fields, code: 'delivery_failed' });
      return failed('delivery_failed');
    }
  };
}
