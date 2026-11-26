// Everything YouTube-specific about reading caption tracks lives behind
// this one module (agentfleet-team/fisheraiagent#65, #68). One call —
// `read(videoId)` — returns what the video's caption tracks prove: a human
// track in the spoken language, only speech-recognition tracks, nothing
// usable, or a failed read. The entry point then decides the transcript
// source (`chooseSource` under the job's captions policy) and, for an
// accepted track, turns its cues into blocks (`cuesToBlocks`).
//
// Method (T0, #66): an InnerTube `player` POST with the ANDROID client
// identity returns a `captions` block whose track `baseUrl`s serve the
// cue text as `fmt=json3`, with no cookie, no PO token and no dependency —
// plain fetch. The spoken language is derived from the player response
// itself; no language list or per-language branch exists anywhere.
import { canonicalVideoUrl } from './youtube-url.js';
import type { Transcript, TranscriptBlock, TranscriptSource } from './transcript.js';

// One timed entry inside a caption track.
export interface Cue {
  start: number;
  end: number;
  text: string;
}

// The failure classes a caption read can land in. Each one sends the job
// to Gemini exactly as if the read had never happened. `unreachable` is
// the remote adapter's class for a reader that cannot be reached at all.
export type CaptionUnavailableReason = 'blocked' | 'timeout' | 'empty' | 'parse' | 'http' | 'unreachable';

// What one read of the video's caption tracks found. `manual` is a human
// track proven to be in the spoken language; `auto` is YouTube's own
// speech-recognition track only; `none` means no track can be proven to be
// in the spoken language; `unavailable` means the read itself failed.
export type CaptionRead =
  | { kind: 'manual' | 'auto'; language: string; durationSeconds: number; cues: Cue[] }
  | { kind: 'none'; durationSeconds?: number }
  | { kind: 'unavailable'; reason: CaptionUnavailableReason };

export type CaptionReader = (videoId: string) => Promise<CaptionRead>;

// How a job treats the caption read — the tenant's `captions` field and
// the CLI's `--accept` values share this vocabulary
// (agentfleet-team/fisheraiagent#69, #89). `manual`, the default, accepts
// only a human track in the spoken language; `manual-or-auto` also accepts
// the spoken-language speech-recognition track; `off` skips the read so
// the job always uses Gemini.
export type CaptionsPolicy = 'manual' | 'manual-or-auto' | 'off';

export function isCaptionsPolicy(value: unknown): value is CaptionsPolicy {
  return value === 'manual' || value === 'manual-or-auto' || value === 'off';
}

// Why a job fell back to Gemini after the read: the read's own kind, or
// its failure reason.
export type GeminiFallbackReason = 'auto' | 'none' | CaptionUnavailableReason;

export interface SourceDecision {
  source: TranscriptSource;
  reason?: GeminiFallbackReason;
}

// N3, table-driven over the job's captions policy: under `manual` (the
// default) only a human track in the spoken language becomes the
// transcript; `manual-or-auto` also accepts the speech-recognition track;
// `off` goes to Gemini whatever the read would have said — a job under
// `off` skips the read before this node runs. No usable track and every
// read failure go to Gemini too, carrying the reason for the log line.
export function chooseSource(read: CaptionRead, policy: CaptionsPolicy = 'manual'): SourceDecision {
  if (policy === 'off') return { source: 'gemini' };
  switch (read.kind) {
    case 'manual':
      return { source: 'captions:manual' };
    case 'auto':
      return policy === 'manual-or-auto' ? { source: 'captions:auto' } : { source: 'gemini', reason: 'auto' };
    case 'none':
      return { source: 'gemini', reason: 'none' };
    case 'unavailable':
      return { source: 'gemini', reason: read.reason };
  }
}

const EPS = 1e-3;

// N4a: cues merged into blocks so a block spans at most maxBlockSeconds.
// A cue longer than the cap stays whole — its own timing is the only
// honest one it has, and inventing sub-cue times would be a guess.
export function cuesToBlocks(cues: Cue[], maxBlockSeconds: number): TranscriptBlock[] {
  const sorted = [...cues].sort((a, b) => a.start - b.start);
  const blocks: TranscriptBlock[] = [];
  let cur: TranscriptBlock | undefined;
  for (const cue of sorted) {
    const start = cur === undefined ? cue.start : Math.max(cue.start, cur.end);
    const end = Math.max(cue.end, start);
    if (cur !== undefined && Math.max(cur.end, end) - cur.start <= maxBlockSeconds + EPS) {
      cur = { start: cur.start, end: Math.max(cur.end, end), text: `${cur.text} ${cue.text}` };
    } else {
      if (cur !== undefined) blocks.push(cur);
      cur = { start, end, text: cue.text };
    }
  }
  if (cur !== undefined) blocks.push(cur);
  return blocks;
}

// N4a's product: the transcript a manual (or, for a tenant that accepts
// it, an auto) track becomes — same shape the Gemini path returns, with
// its source named.
export function captionsTranscript(
  videoId: string,
  read: Extract<CaptionRead, { kind: 'manual' | 'auto' }>,
  maxBlockSeconds: number,
): Transcript {
  return {
    video_id: videoId,
    source_url: canonicalVideoUrl(videoId),
    language: read.language,
    blocks: cuesToBlocks(read.cues, maxBlockSeconds),
    source: read.kind === 'manual' ? 'captions:manual' : 'captions:auto',
  };
}

const PLAYER_URL = 'https://www.youtube.com/youtubei/v1/player?prettyPrint=false';
// The InnerTube client identity T0 measured as serving usable caption
// URLs. The version is a known-rotting constant (YouTube already rejects
// 19.09.37 with HTTP 400); when it dies the read degrades to unavailable
// and jobs go to Gemini, so nothing breaks.
const ANDROID_UA = 'com.google.android.youtube/20.10.38 (Linux; U; Android 11) gzip';
const ANDROID_CLIENT = {
  clientName: 'ANDROID',
  clientVersion: '20.10.38',
  androidSdkVersion: 30,
  osName: 'Android',
  osVersion: '11',
};
// One total budget for the player call plus one track fetch: ~150 ms is
// the observed median, and the design bound the added latency at ~3 s.
const READ_TIMEOUT_MS = 3000;

class ReadFailed extends Error {
  readonly reason: CaptionUnavailableReason;

  constructor(reason: CaptionUnavailableReason) {
    super(reason);
    this.name = 'ReadFailed';
    this.reason = reason;
  }
}

const fail = (reason: CaptionUnavailableReason): never => {
  throw new ReadFailed(reason);
};

// A thrown read is never a job failure: a classified stage failure maps to
// its reason, a timeout to `timeout` and anything else — transport faults
// included — to `http`.
function reasonOf(err: unknown): CaptionUnavailableReason {
  if (err instanceof ReadFailed) return err.reason;
  if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) return 'timeout';
  return 'http';
}

// Remote JSON is unknown until checked; these narrow by name/type so no
// unchecked `as` stands between the response and the code.
function field(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null && key in value ? Reflect.get(value, key) : undefined;
}

function list(value: unknown, key: string): unknown[] {
  const v = field(value, key);
  return Array.isArray(v) ? v : [];
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined;
}

function num(v: unknown): number | undefined {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : undefined;
}

function jsonBody(text: string): unknown {
  if (text.length === 0) fail('empty');
  try {
    return JSON.parse(text);
  } catch {
    return fail('parse');
  }
}

interface CaptionTrack {
  languageCode: string;
  kind: 'manual' | 'asr';
  vssId?: string;
  baseUrl: string;
}

interface TrackListing {
  durationSeconds?: number;
  tracks: CaptionTrack[];
  audioTracks: { audioTrackId?: string }[];
  defaultAudioTrackIndex?: number;
}

const primary = (code: string | undefined): string => (code ?? '').split('-')[0].toLowerCase();

// Which track — if any — the player response proves is in the spoken
// language. No language is ever named; the spoken language always comes
// out of the response itself.
function chooseTrack(listing: TrackListing): { kind: 'manual' | 'auto'; track: CaptionTrack } | undefined {
  const manual = listing.tracks.filter((t) => t.kind === 'manual');
  const asr = listing.tracks.filter((t) => t.kind === 'asr');
  // With no ASR track nothing in the response names the spoken language:
  // the per-audio default caption index follows the viewer's locale, the
  // declared translation source can itself be a translated track, and a
  // lone manual track can be a translation (TLgAJgYqIZk is spoken Korean
  // with one English track). So the answer is none, whatever manual
  // tracks exist.
  if (asr.length === 0) return undefined;
  let original: CaptionTrack | undefined;
  const audio = listing.audioTracks;
  const defaultAudio = listing.defaultAudioTrackIndex === undefined ? undefined : audio[listing.defaultAudioTrackIndex];
  if (audio.length > 1 && defaultAudio?.audioTrackId !== undefined) {
    // YouTube auto-dubbing lists one audio track per language; the
    // default one's id "<lang>.<n>" names the spoken language, and its
    // primary subtag picks the original asr track — the rest are dubs.
    const lang = primary(defaultAudio.audioTrackId.split('.')[0]);
    original = asr.find((t) => primary(t.languageCode) === lang);
  } else if (asr.length === 1) {
    original = asr[0];
  }
  if (original === undefined) return undefined;
  // A manual track counts only when its language has the spoken track's
  // primary subtag; the plain ".<lang>" vssId is preferred over regional
  // variants. With no match the video has asr only.
  const matching = manual.filter((t) => primary(t.languageCode) === primary(original.languageCode));
  const track = matching.find((t) => t.vssId === `.${t.languageCode}`) ?? matching[0];
  if (track !== undefined) return { kind: 'manual', track };
  return { kind: 'auto', track: original };
}

function trackListing(player: unknown): TrackListing {
  const renderer = field(field(player, 'captions'), 'playerCaptionsTracklistRenderer');
  return {
    durationSeconds: num(field(field(player, 'videoDetails'), 'lengthSeconds')),
    tracks: list(renderer, 'captionTracks').map((t) => ({
      languageCode: str(field(t, 'languageCode')) ?? '',
      kind: field(t, 'kind') === 'asr' ? 'asr' : 'manual',
      vssId: str(field(t, 'vssId')),
      baseUrl: str(field(t, 'baseUrl')) ?? '',
    })),
    audioTracks: list(renderer, 'audioTracks').map((a) => ({
      audioTrackId: str(field(a, 'audioTrackId')),
    })),
    defaultAudioTrackIndex: num(field(renderer, 'defaultAudioTrackIndex')),
  };
}

// json3 cue text is the join of each event's segs[].utf8; events without
// segs are window markers, and whitespace collapses across segments.
function parseJson3(body: unknown): Cue[] {
  const cues: Cue[] = [];
  for (const e of list(body, 'events')) {
    const segs = list(e, 'segs');
    if (segs.length === 0) continue;
    const text = segs
      .map((s) => str(field(s, 'utf8')) ?? '')
      .join('')
      .replace(/\s+/g, ' ')
      .trim();
    if (!text) continue;
    const start = (num(field(e, 'tStartMs')) ?? 0) / 1000;
    cues.push({ start, end: start + (num(field(e, 'dDurationMs')) ?? 0) / 1000, text });
  }
  return cues;
}

async function fetchJson(fetchImpl: typeof fetch, url: string | URL, init: RequestInit): Promise<unknown> {
  const res = await fetchImpl(url, init);
  const text = await res.text();
  if (!res.ok) fail('http');
  return jsonBody(text);
}

// Track baseUrls are signed and expire (~6 h), so the track fetch must
// share the read's own deadline rather than being queued for later.
async function fetchCues(fetchImpl: typeof fetch, baseUrl: string, signal: AbortSignal): Promise<Cue[]> {
  const url = new URL(baseUrl);
  url.searchParams.set('fmt', 'json3');
  const body = await fetchJson(fetchImpl, url, { headers: { 'user-agent': 'Mozilla/5.0' }, signal });
  return parseJson3(body);
}

// The real reader. Every YouTube-side failure returns `unavailable` with a
// reason — it never throws on the video's behalf and never retries.
export function createCaptionReader(options?: { fetchImpl?: typeof fetch; timeoutMs?: number }): CaptionReader {
  const fetchImpl = options?.fetchImpl ?? fetch;
  const timeoutMs = options?.timeoutMs ?? READ_TIMEOUT_MS;
  return async (videoId) => {
    try {
      // One shared signal gives the two requests a single total budget.
      const signal = AbortSignal.timeout(timeoutMs);
      const player = await fetchJson(fetchImpl, PLAYER_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'user-agent': ANDROID_UA,
          'x-youtube-client-name': '3',
          'x-youtube-client-version': ANDROID_CLIENT.clientVersion,
        },
        body: JSON.stringify({
          context: { client: { ...ANDROID_CLIENT, hl: 'en', gl: 'US' } },
          videoId,
          contentCheckOk: true,
          racyCheckOk: true,
        }),
        signal,
      });
      if (str(field(field(player, 'playabilityStatus'), 'status')) !== 'OK') fail('blocked');
      const listing = trackListing(player);
      const chosen = chooseTrack(listing);
      if (chosen === undefined) {
        const none: CaptionRead = { kind: 'none' };
        if (listing.durationSeconds !== undefined) none.durationSeconds = listing.durationSeconds;
        return none;
      }
      const cues = await fetchCues(fetchImpl, chosen.track.baseUrl, signal);
      if (cues.length === 0) fail('empty');
      return {
        kind: chosen.kind,
        language: chosen.track.languageCode,
        durationSeconds: listing.durationSeconds ?? cues.at(-1)?.end ?? 0,
        cues,
      };
    } catch (err) {
      return { kind: 'unavailable', reason: reasonOf(err) };
    }
  };
}
