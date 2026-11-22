import { TranscriptError } from './errors.js';
import { parseVideoId } from './ids.js';
import { loggerFor, type LogSink } from './log.js';
import type { GeminiCaller, GeminiVideoResponse } from './gemini.js';
import { ModelOutputError, parseModelOutput, type ParsedModelOutput } from './model-output.js';
import { clipPrompt, STRICT_RETRY_SUFFIX } from './prompts.js';
import { readCachedTranscript, TRANSCRIPT_FORMAT_VERSION, writeCachedTranscript } from './cache.js';
import { DEFAULT_WINDOW_SECONDS } from './config.js';
import { canonicalVideoUrl } from './youtube-url.js';
import type { Transcript, TranscriptBlock } from './transcript.js';

export interface TranscribeDeps {
  caller: GeminiCaller;
  model: string;
  maxBlockSeconds: number;
  cacheDir: string;
  log?: LogSink;
  // Cache key component: defaults to TRANSCRIPT_FORMAT_VERSION, bumped on
  // every prompt, format or parser change. Tests set it directly to prove
  // a version bump makes old entries misses.
  formatVersion?: number;
  // A per-tenant length cap. A video known (or discovered on the first
  // model response) to be longer fails with video_too_long instead of
  // spending further Gemini calls.
  maxVideoSeconds?: number;
  // Length of one clipped window in seconds. Every Gemini call carries a
  // start and an end offset, so block times re-anchor at a known point per
  // window instead of drifting across a single long generation.
  windowSeconds?: number;
}

interface RoundResult extends ParsedModelOutput {
  status: string;
  noMoreContent?: boolean;
}

const MAX_WINDOW_RERUNS = 8;
const EPS = 1e-3;
// Block times are whole seconds, so boundary rounding can leave a gap of
// about a second between honest adjacent blocks; only a larger hole is
// treated as dropped coverage.
const GAP_TOLERANCE_SECONDS = 2;
// A window's coverage is finished only when the response itself says so:
// a non-truncated status, no hole in coverage, and a last block that ends
// a sentence — or coverage that reaches the window's known end. The
// model's self-reported video duration is never trusted.
const TERMINAL_PUNCTUATION = /\p{Terminal_Punctuation}[\p{Pf}\p{Pe}"']*$/u;
// Only a 400 that specifically reports a start offset past the video end
// means "nothing left"; any other 400 is a real failure. Such a 400 may be
// classified as video_unavailable or upstream_rejected depending on the
// upstream wording; either code ends the video here.
const PAST_END_OFFSET_MESSAGE = /offset|past (the )?end|beyond (the )?(video |end|duration|length)|exceeds? (the )?(video )?(duration|length)/i;

async function callRound(
  videoId: string,
  videoUrl: string,
  clipStart: number,
  clipEnd: number,
  deps: TranscribeDeps,
): Promise<RoundResult> {
  // Usage metadata rides every successful call so the input-token cost of
  // one video can be summed from the log.
  const logUsage = (res: GeminiVideoResponse) =>
    loggerFor(deps.log)('gemini_call', {
      video: parseVideoId(videoId),
      inputTokens: res.usage?.promptTokenCount,
      outputTokens: res.usage?.candidatesTokenCount,
      totalTokens: res.usage?.totalTokenCount,
    });

  const request = async (strict: boolean) => {
    const base = clipPrompt(deps.maxBlockSeconds, clipEnd - clipStart);
    const res = await deps.caller({
      videoUrl,
      prompt: strict ? base + STRICT_RETRY_SUFFIX : base,
      startOffsetSeconds: clipStart,
      endOffsetSeconds: clipEnd,
    });
    logUsage(res);
    return res;
  };

  const run = async (): Promise<RoundResult> => {
    // Every call is a clip, so a header-only answer is always legal: it is
    // the model reporting no spoken audio in the requested range.
    const parse = (text: string) => parseModelOutput(text, deps.maxBlockSeconds, { allowEmpty: true });
    try {
      const res = await request(false);
      return { ...parse(res.text), status: res.status };
    } catch (err) {
      if (err instanceof ModelOutputError) {
        // One retry with a stricter instruction, then give up.
        const res = await request(true);
        try {
          return { ...parse(res.text), status: res.status };
        } catch (second) {
          throw new TranscriptError('bad_model_output', 'model output not in expected format', { cause: second });
        }
      }
      throw err;
    }
  };

  try {
    const out = await run();
    // An empty answer means the model reports no spoken audio in the
    // clip; like a past-end start offset it marks the range as finished.
    if (out.blocks.length === 0) out.noMoreContent = true;
    return out;
  } catch (err) {
    // A start offset is only sent for clipStart > 0, so only those calls
    // can legitimately land past the video end.
    if (clipStart > 0 && isPastEndOffsetError(err)) {
      return { language: 'unknown', blocks: [], status: 'completed', noMoreContent: true };
    }
    throw err;
  }
}

function isPastEndOffsetError(err: unknown): boolean {
  return (
    err instanceof TranscriptError &&
    (err.code === 'video_unavailable' || err.code === 'upstream_rejected') &&
    err.httpStatus === 400 &&
    PAST_END_OFFSET_MESSAGE.test(err.message)
  );
}

// Clip-relative block times shift to video time by the clip's known start,
// and the window end is a hard clamp: drift inside one window can never
// reach into the next, so a block reported past the clip end is cut off
// (the next window re-transcribes that audio) and a block that starts
// past it is dropped.
function shiftClipBlocks(blocks: TranscriptBlock[], clipStart: number, windowEnd: number): TranscriptBlock[] {
  const shifted: TranscriptBlock[] = [];
  for (const b of blocks) {
    const start = b.start + clipStart;
    if (start >= windowEnd) continue;
    shifted.push({ start, end: Math.min(b.end + clipStart, windowEnd), text: b.text });
  }
  return shifted;
}

// Insert rerun blocks into uncovered holes. A block that overlaps coverage
// we already have is repeated or jittered output and is dropped, so merged
// start and end times stay monotonic.
function mergeNewBlocks(blocks: TranscriptBlock[], incoming: TranscriptBlock[]): number {
  let added = 0;
  for (const b of incoming) {
    const overlaps = blocks.some((e) => b.start < e.end - EPS && b.end > e.start + EPS);
    if (overlaps) continue;
    const at = blocks.findIndex((e) => e.start > b.start);
    blocks.splice(at === -1 ? blocks.length : at, 0, b);
    added += 1;
  }
  return added;
}

function assertOrderedEnds(blocks: TranscriptBlock[]): void {
  for (let i = 1; i < blocks.length; i++) {
    if (blocks[i].end < blocks[i - 1].end - EPS) {
      throw new TranscriptError(
        'bad_model_output',
        `merged transcript is out of order: block ${i + 1} ends before the previous block`,
      );
    }
  }
}

// The first place where coverage jumps forward, i.e. where the model skipped
// a segment of audio; returns the end of the block before the hole.
function findFirstHole(blocks: TranscriptBlock[]): number | undefined {
  for (let i = 1; i < blocks.length; i++) {
    if (blocks[i].start - blocks[i - 1].end > GAP_TOLERANCE_SECONDS) {
      return blocks[i - 1].end;
    }
  }
  return undefined;
}

interface WindowOutcome {
  blocks: TranscriptBlock[];
  language: string;
  durationSeconds?: number;
  // True when the window's first call reports no speech (or its start
  // offset lands past the video end): the video is finished.
  empty: boolean;
}

// One clipped window: a first call over [windowStart, windowEnd), then
// clipped reruns for the ranges its responses left uncovered. Every call's
// block times are relative to that call's own clip start, so a rerun can
// never corrupt coverage already merged.
async function transcribeWindow(
  videoId: string,
  videoUrl: string,
  windowStart: number,
  windowEnd: number,
  deps: TranscribeDeps,
): Promise<WindowOutcome> {
  const blocks: TranscriptBlock[] = [];
  let language = 'unknown';
  let durationSeconds: number | undefined;
  let clipStart = windowStart;

  for (let round = 0; ; round++) {
    const out = await callRound(videoId, videoUrl, clipStart, windowEnd, deps);
    if (round === 0) durationSeconds = out.durationSeconds;
    if (out.language !== 'unknown') language = out.language;
    const added = mergeNewBlocks(blocks, shiftClipBlocks(out.blocks, clipStart, windowEnd));

    if (out.noMoreContent) {
      // Round 0: the whole window is speechless (or starts past the video
      // end), so the video is over. A rerun: the range is confirmed
      // silence and the window's coverage stands.
      return { blocks, language, durationSeconds, empty: round === 0 };
    }
    // A rerun that adds nothing new has said all it will say about the
    // range; the window's coverage stands.
    if (round > 0 && added === 0) break;

    const truncated = out.status === 'incomplete' || out.status === 'requires_continuation';
    const hole = findFirstHole(blocks);
    const last = blocks[blocks.length - 1];
    const endsSentence = TERMINAL_PUNCTUATION.test(last.text);
    const reachesEnd = last.end >= windowEnd - EPS;

    if (!truncated && hole === undefined && (endsSentence || reachesEnd)) break;
    if (round >= MAX_WINDOW_RERUNS) {
      throw new TranscriptError(
        'bad_model_output',
        `window coverage incomplete after ${MAX_WINDOW_RERUNS} continuation requests`,
      );
    }
    // Rerun only the missing range, clipped at the window end: a hole is
    // re-covered from where coverage broke off, everything else continues
    // from the last block's end.
    clipStart = hole ?? last.end;
    if (clipStart >= windowEnd - EPS) break;
  }

  return { blocks, language, durationSeconds, empty: false };
}

export async function transcribeVideo(videoId: string, deps: TranscribeDeps): Promise<Transcript> {
  const videoUrl = canonicalVideoUrl(videoId);
  const windowSeconds = deps.windowSeconds ?? DEFAULT_WINDOW_SECONDS;
  const blocks: TranscriptBlock[] = [];
  let language = 'unknown';

  const result = (): Transcript => {
    assertOrderedEnds(blocks);
    return {
      video_id: videoId,
      source_url: videoUrl,
      language,
      blocks,
    };
  };

  for (let windowStart = 0; ; windowStart += windowSeconds) {
    const out = await transcribeWindow(videoId, videoUrl, windowStart, windowStart + windowSeconds, deps);

    // The first response declares the video's duration; an over-limit
    // video is rejected here, before any continuation call.
    if (
      windowStart === 0 &&
      deps.maxVideoSeconds !== undefined &&
      out.durationSeconds !== undefined &&
      out.durationSeconds > deps.maxVideoSeconds
    ) {
      throw new TranscriptError('video_too_long', 'video exceeds the tenant length limit');
    }

    if (out.language !== 'unknown') language = out.language;
    blocks.push(...out.blocks);

    if (out.empty) {
      if (blocks.length === 0) {
        throw new TranscriptError('bad_model_output', 'model produced no transcript blocks');
      }
      return result();
    }
    // Coverage past the tenant limit rejects the video even when the
    // model never declared a duration.
    if (deps.maxVideoSeconds !== undefined && blocks[blocks.length - 1].end > deps.maxVideoSeconds) {
      throw new TranscriptError('video_too_long', 'video exceeds the tenant length limit');
    }
  }
}

export async function transcribeYouTube(videoId: string, deps: TranscribeDeps): Promise<Transcript> {
  const formatVersion = deps.formatVersion ?? TRANSCRIPT_FORMAT_VERSION;
  const windowSeconds = deps.windowSeconds ?? DEFAULT_WINDOW_SECONDS;
  const cached = await readCachedTranscript(
    deps.cacheDir,
    videoId,
    deps.model,
    deps.maxBlockSeconds,
    windowSeconds,
    formatVersion,
  );
  if (cached) {
    const coverage = cached.blocks.length > 0 ? Math.max(...cached.blocks.map((b) => b.end)) : 0;
    if (deps.maxVideoSeconds !== undefined && coverage > deps.maxVideoSeconds) {
      throw new TranscriptError('video_too_long', 'video exceeds the tenant length limit');
    }
    loggerFor(deps.log)('cache_hit', { video: parseVideoId(videoId) });
    return cached;
  }
  const transcript = await transcribeVideo(videoId, deps);
  await writeCachedTranscript(
    deps.cacheDir,
    transcript,
    deps.model,
    deps.maxBlockSeconds,
    windowSeconds,
    formatVersion,
  );
  return transcript;
}
