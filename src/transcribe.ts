import { captionsTranscript, chooseSource } from './captions.js';
import type { CaptionRead, CaptionReader } from './captions.js';
import { TranscriptError } from './errors.js';
import { parseVideoId } from './ids.js';
import { loggerFor, type LogSink } from './log.js';
import { isMediaDataError, type GeminiCaller, type GeminiVideoResponse } from './gemini.js';
import { ModelOutputError, parseModelOutput, type ParsedModelOutput } from './model-output.js';
import { clipPrompt, STRICT_RETRY_SUFFIX } from './prompts.js';
import { readCachedTranscript, TRANSCRIPT_FORMAT_VERSION, writeCachedTranscript } from './cache.js';
import { DEFAULT_MAX_VIDEO_SECONDS, DEFAULT_WINDOW_SECONDS } from './config.js';
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
  // The cap applied when maxVideoSeconds is unset — entry points supply
  // their configured MAX_VIDEO_SECONDS here. Without it the window loop
  // has no bound: a caller that always reports more speech would request
  // windows without end, so unset falls back to DEFAULT_MAX_VIDEO_SECONDS.
  defaultMaxVideoSeconds?: number;
  // Length of one clipped window in seconds. Every Gemini call carries a
  // start and an end offset, so block times re-anchor at a known point per
  // window instead of drifting across a single long generation.
  windowSeconds?: number;
  // Reads the video's caption tracks before any Gemini call (nodes
  // N2->N3->N4a of the job workflow). When a manual track in the spoken
  // language exists it becomes the transcript with zero Gemini calls;
  // every other outcome is the Gemini path exactly as today. Unset means
  // "always Gemini" — the behavior before this dependency existed.
  captionReader?: CaptionReader;
}

interface RoundResult extends ParsedModelOutput {
  status: string;
  noMoreContent?: boolean;
  // The first request's input token count. It tracks the real clip length
  // upstream billed for, so a window billed far under the first window's
  // count is the tail where the video ended.
  promptTokens?: number;
}

const MAX_WINDOW_RERUNS = 8;
// A later window whose first-round input token count falls under this
// share of the first window's count is the tail: the API billed a shorter
// clip because the video ends inside it.
const TAIL_TOKEN_RATIO = 0.97;
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

// One clip request. windowStart is the owning window's start, recorded on
// the parse-failure log event; exactClipLength marks the re-asked tail
// window whose prompt may state the estimated real length. strictFirst
// makes the first request itself the strict variant, used for the one
// re-ask a full-length window gets after a no-usable-blocks answer.
async function callRound(
  videoId: string,
  videoUrl: string,
  clipStart: number,
  clipEnd: number,
  deps: TranscribeDeps,
  windowStart: number,
  exactClipLength = false,
  strictFirst = false,
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
    const base = clipPrompt(deps.maxBlockSeconds, clipEnd - clipStart, exactClipLength);
    const res = await deps.caller({
      videoUrl,
      prompt: strict ? base + STRICT_RETRY_SUFFIX : base,
      startOffsetSeconds: clipStart,
      endOffsetSeconds: clipEnd,
      logContext: { video: parseVideoId(videoId), windowStart },
    });
    logUsage(res);
    return res;
  };

  // One sub-clip request over an over-limit block's own [start, end),
  // clipped at the parent clip's end: raw block times can drift past the
  // window end or the estimated tail end, but no request may cross the
  // clip's boundary, and the prompt states the length actually asked for.
  // The answer's times are relative to the sub-clip's start, so they
  // re-anchor at the block's start. A failed call, a malformed or
  // still-over-limit answer, a reply reporting no speech, and spans
  // running past the requested range — which would merge over the next
  // block's coverage — all produce undefined: the caller then keeps the
  // original block rather than inventing or splitting text.
  const subClip = async (b: TranscriptBlock): Promise<TranscriptBlock[] | undefined> => {
    const subEnd = Math.min(clipStart + b.end, clipEnd);
    const subSeconds = subEnd - (clipStart + b.start);
    if (subSeconds <= EPS) return undefined;
    loggerFor(deps.log)('gemini_extra_call', {
      video: parseVideoId(videoId),
      reason: 'subclip',
      windowStart,
    });
    try {
      const res = await deps.caller({
        videoUrl,
        prompt: clipPrompt(deps.maxBlockSeconds, subSeconds, true),
        startOffsetSeconds: clipStart + b.start,
        endOffsetSeconds: subEnd,
        logContext: { video: parseVideoId(videoId), windowStart },
      });
      logUsage(res);
      const { blocks } = parseModelOutput(res.text, deps.maxBlockSeconds, { allowEmpty: true });
      if (blocks.length === 0 || blocks.some((s) => s.end > subSeconds + EPS)) return undefined;
      return blocks.map((s) => ({ start: s.start + b.start, end: s.end + b.start, text: s.text }));
    } catch {
      return undefined;
    }
  };

  // An answer whose only offense is a span over the block limit keeps its
  // valid blocks: each over-limit block's own range is re-asked once as a
  // sub-clip and the returned blocks take its place in order. A block
  // whose sub-clip still cannot produce in-limit blocks is kept verbatim
  // and reported once per answer as block_over_limit — count and longest
  // span only, never text. Other parse failures throw before this point.
  const repairOverLimit = async (parsed: ParsedModelOutput): Promise<ParsedModelOutput> => {
    const { overLimit, ...rest } = parsed;
    if (!overLimit) return rest;
    const kept: number[] = [];
    const blocks: TranscriptBlock[] = [];
    for (const b of parsed.blocks) {
      const span = b.end - b.start;
      if (span <= deps.maxBlockSeconds + EPS) {
        blocks.push(b);
        continue;
      }
      const sub = await subClip(b);
      if (sub === undefined) {
        blocks.push(b);
        kept.push(span);
      } else {
        blocks.push(...sub);
      }
    }
    if (kept.length > 0) {
      loggerFor(deps.log)('block_over_limit', {
        windowStart,
        count: kept.length,
        longestBlockSeconds: Math.round(Math.max(...kept) * 1e3) / 1e3,
      });
    }
    return { ...rest, blocks };
  };

  const run = async (): Promise<RoundResult> => {
    // Every call is a clip, so a header-only answer is always legal: it is
    // the model reporting no spoken audio in the requested range. Spans
    // over the block limit are tolerated at parse time and repaired by
    // sub-clip re-asks, so block length alone never spends the strict
    // whole-window retry.
    const parse = (text: string) =>
      parseModelOutput(text, deps.maxBlockSeconds, { allowEmpty: true, allowOverLimitBlocks: true });
    let promptTokens: number | undefined;
    try {
      const res = await request(strictFirst);
      promptTokens = res.usage?.promptTokenCount;
      return { ...(await repairOverLimit(parse(res.text))), status: res.status, promptTokens };
    } catch (err) {
      if (err instanceof ModelOutputError) {
        loggerFor(deps.log)('model_output_error', { reason: err.reason, windowStart });
        // One retry with a stricter instruction, then give up.
        loggerFor(deps.log)('gemini_extra_call', {
          video: parseVideoId(videoId),
          reason: 'strict_retry',
          windowStart,
        });
        const res = await request(true);
        try {
          return { ...(await repairOverLimit(parse(res.text))), status: res.status, promptTokens };
        } catch (second) {
          if (second instanceof ModelOutputError) {
            loggerFor(deps.log)('model_output_error', { reason: second.reason, windowStart });
          }
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

// A media-data failure an unmapped caller threw raw, reported with the same
// code the mapped Gemini caller would have produced.
function asUpstreamMediaError(err: unknown): TranscriptError {
  if (err instanceof TranscriptError) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new TranscriptError('upstream_media_error', `Gemini could not process the media data: ${message}`, {
    httpStatus: 400,
  });
}

// One clip request with the media-data policy applied. A raw media 400 from
// an unmapped caller never saw the single retry the Gemini caller performs
// itself, so it is run here; a repeat media failure is surfaced as
// upstream_media_error for the window loop to weigh against coverage.
async function callRoundChecked(
  videoId: string,
  videoUrl: string,
  clipStart: number,
  clipEnd: number,
  deps: TranscribeDeps,
  windowStart: number,
  exactClipLength = false,
  strictFirst = false,
): Promise<RoundResult> {
  try {
    return await callRound(videoId, videoUrl, clipStart, clipEnd, deps, windowStart, exactClipLength, strictFirst);
  } catch (err) {
    if (!isMediaDataError(err) || err instanceof TranscriptError) throw err;
    loggerFor(deps.log)('gemini_extra_call', {
      video: parseVideoId(videoId),
      reason: 'media_retry',
      windowStart,
    });
    try {
      return await callRound(videoId, videoUrl, clipStart, clipEnd, deps, windowStart, exactClipLength, strictFirst);
    } catch (second) {
      if (isMediaDataError(second)) throw asUpstreamMediaError(second);
      throw second;
    }
  }
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

// The part of a rerun block that is not covered yet. Accepted coverage is
// sorted by start, so the scan finds the first gap between it and the
// incoming range; a block that only restates known coverage has none.
function uncoveredPart(b: TranscriptBlock, blocks: TranscriptBlock[]): TranscriptBlock | undefined {
  let start = b.start;
  for (const e of blocks) {
    if (e.end <= start + EPS) continue;
    if (e.start >= b.end - EPS) break;
    if (e.start > start + EPS) return { start, end: Math.min(e.start, b.end), text: b.text };
    start = Math.max(start, e.end);
    if (start >= b.end - EPS) return undefined;
  }
  return { start, end: b.end, text: b.text };
}

// Insert rerun blocks into uncovered holes. A block identical to coverage
// we already accepted is a repeat and is dropped, and a block that only
// partially overlaps is trimmed to its uncovered part, so merged start and
// end times stay monotonic and no block is duplicated.
function mergeNewBlocks(blocks: TranscriptBlock[], incoming: TranscriptBlock[]): number {
  let added = 0;
  for (const b of incoming) {
    const duplicate = blocks.some(
      (e) => Math.abs(e.start - b.start) <= EPS && Math.abs(e.end - b.end) <= EPS && e.text === b.text,
    );
    if (duplicate) continue;
    const uncovered = uncoveredPart(b, blocks);
    if (uncovered === undefined) continue;
    const at = blocks.findIndex((e) => e.start > uncovered.start);
    blocks.splice(at === -1 ? blocks.length : at, 0, uncovered);
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
  // True when the window's first call reports no speech (or its start
  // offset lands past the video end): the video is finished. A window
  // billed at the full-window reference reports the same answer as
  // recorded silence instead, so it never sets this.
  empty: boolean;
  // Whether the most recent successful response covering this window's
  // range finished normally ('completed'). A truncated response is
  // evidence that more speech exists, so a later media-data fault must
  // not be read as the video's end.
  lastRoundCompleted: boolean;
  // The first-round non-strict request's input token count; the caller
  // keeps the first window's as the full-window reference.
  promptTokens?: number;
  // True when the token count showed this window is the video's tail:
  // its clip was re-asked at the estimated real end and no later window
  // exists.
  videoEnded: boolean;
}

// The length bound for this video: the tenant's own limit, else the
// configured default, else DEFAULT_MAX_VIDEO_SECONDS — the window loop
// always has a hard bound, so a model that never reports silence fails
// with video_too_long instead of running without end.
function lengthLimit(deps: TranscribeDeps): number {
  return deps.maxVideoSeconds ?? deps.defaultMaxVideoSeconds ?? DEFAULT_MAX_VIDEO_SECONDS;
}

// One clipped window: a first call over [windowStart, windowEnd), then
// clipped reruns for the ranges its responses left uncovered. Every call's
// block times are relative to that call's own clip start, so a rerun can
// never corrupt coverage already merged. coveredEndAtWindowStart is where
// the transcript's coverage stood when this window began, and
// priorRoundCompleted says whether the response that produced it finished
// normally. fullWindowTokens is the first window's first-round input token
// count, the reference a later window's count is measured against, and
// maxVideoSeconds is the resolved length bound (tenant cap or default).
async function transcribeWindow(
  videoId: string,
  videoUrl: string,
  windowStart: number,
  windowEnd: number,
  deps: TranscribeDeps,
  maxVideoSeconds: number,
  coveredEndAtWindowStart?: number,
  priorRoundCompleted?: boolean,
  fullWindowTokens?: number,
): Promise<WindowOutcome> {
  const blocks: TranscriptBlock[] = [];
  let language = 'unknown';
  let clipStart = windowStart;
  let lastRoundCompleted = priorRoundCompleted ?? false;
  let promptTokens: number | undefined;
  let videoEnded = false;
  // The first round's token count proved this window is full-length
  // media: it can hold silence but it can never be the end of the video.
  let fullLengthWindow = false;

  // Clip-relative block times shifted into video time and clamped at the
  // window end; a block the clamp drops is counted once on the log with
  // the window start, never with its text.
  const shiftAndLog = (o: RoundResult): TranscriptBlock[] => {
    const kept = shiftClipBlocks(o.blocks, clipStart, windowEnd);
    const dropped = o.blocks.length - kept.length;
    if (dropped > 0) {
      loggerFor(deps.log)('clip_blocks_dropped', { windowStart, count: dropped });
    }
    return kept;
  };

  for (let round = 0; ; round++) {
    let out: RoundResult;
    let shifted: TranscriptBlock[] = [];
    try {
      out = await callRoundChecked(videoId, videoUrl, clipStart, windowEnd, deps, windowStart);
      // A later window billed far under the reference is the tail: the
      // video ends inside the clip, and an open-ended prompt would let the
      // model stretch block times across the silence. Discard the answer
      // and re-ask once with the clip end set to just past the estimated
      // video end, so the prompt states the true clip length; that answer
      // is the window's first response and no later window is requested.
      if (
        round === 0 &&
        windowStart > 0 &&
        fullWindowTokens !== undefined &&
        out.promptTokens !== undefined &&
        out.promptTokens < fullWindowTokens * TAIL_TOKEN_RATIO
      ) {
        const estimatedEnd = windowStart + (windowEnd - windowStart) * (out.promptTokens / fullWindowTokens);
        windowEnd = Math.ceil(estimatedEnd) + 1;
        videoEnded = true;
        loggerFor(deps.log)('gemini_extra_call', {
          video: parseVideoId(videoId),
          reason: 'tail_reask',
          windowStart,
        });
        out = await callRoundChecked(videoId, videoUrl, clipStart, windowEnd, deps, windowStart, true);
      }
      shifted = shiftAndLog(out);
      if (round === 0) {
        // A window billed at or over the full-window reference is
        // full-length media: the API charged for the whole clip, so the
        // video cannot end inside it. An empty or all-dropped answer
        // there is unusable output, not evidence the video ended; the
        // same clip is re-asked once with the strict prompt, whose
        // clip-relative times instruction answers the failure seen live.
        fullLengthWindow =
          !videoEnded &&
          fullWindowTokens !== undefined &&
          out.promptTokens !== undefined &&
          out.promptTokens >= fullWindowTokens * TAIL_TOKEN_RATIO;
        if (fullLengthWindow && shifted.length === 0) {
          loggerFor(deps.log)('gemini_extra_call', {
            video: parseVideoId(videoId),
            reason: 'empty_full_window',
            windowStart,
          });
          out = await callRoundChecked(videoId, videoUrl, clipStart, windowEnd, deps, windowStart, false, true);
          shifted = shiftAndLog(out);
        }
      }
    } catch (err) {
      if (!isMediaDataError(err)) throw err;
      // A media-data 400 ends the video only on evidence already in hand:
      // the request starts past offset 0, the most recent successful
      // response covering the range before it finished normally, and that
      // coverage stopped before the boundary this request asks about (the
      // window start for a first call, the rerun's own start after that).
      // An offset-0 fault, coverage that reached the boundary, a
      // truncated response, the failed re-ask of a token-detected
      // tail — whose discarded answer already proved speech there — or
      // any fault inside a token-proven full-length window stays a real
      // upstream error.
      const coveredEnd = blocks.at(-1)?.end ?? coveredEndAtWindowStart;
      const endedBeforeBoundary =
        coveredEnd !== undefined &&
        (round === 0 ? coveredEnd < windowStart - EPS : coveredEnd <= clipStart + EPS);
      if (clipStart > 0 && lastRoundCompleted && endedBeforeBoundary && !videoEnded && !fullLengthWindow) {
        return { blocks, language, empty: true, lastRoundCompleted, promptTokens, videoEnded };
      }
      throw err;
    }
    lastRoundCompleted = out.status === 'completed';
    if (round === 0) {
      promptTokens = out.promptTokens;
      // A first response that declares an over-limit duration rejects the
      // video here, before any continuation call is spent.
      if (windowStart === 0 && out.durationSeconds !== undefined && out.durationSeconds > maxVideoSeconds) {
        throw new TranscriptError('video_too_long', 'video exceeds the length limit');
      }
    }
    if (out.language !== 'unknown') language = out.language;
    const added = mergeNewBlocks(blocks, shifted);

    if (out.noMoreContent) {
      // Round 0: the whole window is speechless (or starts past the video
      // end), so the video is over — unless its token count proved it
      // full-length media, where an empty answer even after the strict
      // re-ask is recorded as silence and the loop goes on. A rerun: the
      // range is confirmed silence and the window's coverage stands.
      return {
        blocks,
        language,
        empty: round === 0 && !fullLengthWindow,
        lastRoundCompleted,
        promptTokens,
        videoEnded,
      };
    }
    if (blocks.length === 0) {
      // A full-length window whose answer stayed all-dropped after the
      // strict re-ask is recorded as silence; the loop continues at the
      // next window. Any other window's all-dropped answer is unusable
      // output, not evidence of silence.
      if (fullLengthWindow) {
        return { blocks, language, empty: false, lastRoundCompleted, promptTokens, videoEnded };
      }
      throw new TranscriptError('bad_model_output', 'model output contained no usable blocks for the clip');
    }
    // The re-asked tail answer is the window's final coverage: the token
    // estimate already fixed the video end, so no further coverage call is
    // spent inside this window.
    if (videoEnded) break;
    // A rerun that adds nothing new has said all it will say about the
    // range; the window's coverage stands.
    if (round > 0 && added === 0) break;

    const truncated = out.status === 'incomplete' || out.status === 'requires_continuation';
    const hole = findFirstHole(blocks);
    const last = blocks[blocks.length - 1];
    // A first response that covered more than a block of the window and
    // stopped within a block of its end may have dropped a trailing block;
    // that short tail is confirmed by a rerun rather than trusted on a
    // sentence end. A response that stopped early — or coverage already
    // cross-checked by reruns — still completes on its sentence end.
    const tailUnconfirmed =
      round === 0 &&
      last.end - windowStart > deps.maxBlockSeconds &&
      windowEnd - last.end <= deps.maxBlockSeconds;
    const endsSentence = TERMINAL_PUNCTUATION.test(last.text) && !tailUnconfirmed;
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
    // from the last block's end. Reaching the loop's bottom means one
    // more request is spent inside this window, logged so every call
    // past a clip's first is charged to a reason.
    clipStart = hole ?? last.end;
    if (clipStart >= windowEnd - EPS) break;
    loggerFor(deps.log)('gemini_extra_call', {
      video: parseVideoId(videoId),
      reason: 'continuation',
      windowStart,
    });
  }

  return { blocks, language, empty: false, lastRoundCompleted, promptTokens, videoEnded };
}

export async function transcribeVideo(videoId: string, deps: TranscribeDeps): Promise<Transcript> {
  const videoUrl = canonicalVideoUrl(videoId);
  const windowSeconds = deps.windowSeconds ?? DEFAULT_WINDOW_SECONDS;
  const maxVideoSeconds = lengthLimit(deps);
  const blocks: TranscriptBlock[] = [];
  let language = 'unknown';
  // Whether the response that produced the tail of the accepted coverage
  // finished normally; seeded false so a media fault on the very first
  // request can never read as end of video.
  let lastRoundCompleted = false;
  // The first window's first-round input token count is the full-window
  // reference every later window is measured against. When the first
  // window is itself short or the response carried no usage metadata
  // there is no reference and the coverage rules below decide alone.
  let fullWindowTokens: number | undefined;

  const result = (): Transcript => {
    assertOrderedEnds(blocks);
    return {
      video_id: videoId,
      source_url: videoUrl,
      language,
      blocks,
      source: 'gemini',
    };
  };

  for (let windowStart = 0; ; windowStart += windowSeconds) {
    const out = await transcribeWindow(
      videoId,
      videoUrl,
      windowStart,
      windowStart + windowSeconds,
      deps,
      maxVideoSeconds,
      blocks.at(-1)?.end,
      lastRoundCompleted,
      fullWindowTokens,
    );

    if (out.language !== 'unknown') language = out.language;
    blocks.push(...out.blocks);
    lastRoundCompleted = out.lastRoundCompleted;
    if (windowStart === 0) fullWindowTokens = out.promptTokens;

    if (out.empty) {
      if (blocks.length === 0) {
        throw new TranscriptError('bad_model_output', 'model produced no transcript blocks');
      }
      return result();
    }
    // A window recorded as silence contributes no coverage, but its full
    // bill proves the video runs through the whole window: once that
    // proven reach crosses the length limit the video is too long. This
    // is also what bounds the loop when the model reports silence without
    // end — coverage alone cannot grow to meet the bound.
    if (out.blocks.length === 0 && windowStart + windowSeconds > maxVideoSeconds) {
      throw new TranscriptError('video_too_long', 'video exceeds the length limit');
    }
    // Coverage past the length limit rejects the video even when the
    // model never declared a duration; with no tenant cap the default
    // bound is what stops the window loop. A window recorded as silence
    // may leave the transcript empty still, so the last block is looked
    // up, not assumed.
    const lastEnd = blocks.at(-1)?.end;
    if (lastEnd !== undefined && lastEnd > maxVideoSeconds) {
      throw new TranscriptError('video_too_long', 'video exceeds the length limit');
    }
    // The token count already proved this window holds the video end.
    if (out.videoEnded) return result();
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
    if (coverage > lengthLimit(deps)) {
      throw new TranscriptError('video_too_long', 'video exceeds the length limit');
    }
    loggerFor(deps.log)('cache_hit', { video: parseVideoId(videoId) });
    return cached;
  }
  if (deps.captionReader !== undefined) {
    const startedAt = Date.now();
    // The reader contract is "never throw", but the entry point folds a
    // throwing reader into `unavailable` anyway — a read bug must never
    // break a job, it only costs the saving.
    let read: CaptionRead;
    try {
      read = await deps.captionReader(videoId);
    } catch {
      read = { kind: 'unavailable', reason: 'http' };
    }
    loggerFor(deps.log)('captions_read', {
      video: parseVideoId(videoId),
      kind: read.kind,
      reason: read.kind === 'unavailable' ? read.reason : undefined,
      durationMs: Date.now() - startedAt,
    });
    // The player response's duration applies the length limit before any
    // further work on either path.
    if ('durationSeconds' in read && read.durationSeconds !== undefined && read.durationSeconds > lengthLimit(deps)) {
      throw new TranscriptError('video_too_long', 'video exceeds the length limit');
    }
    const decision = chooseSource(read);
    loggerFor(deps.log)('source_chosen', {
      video: parseVideoId(videoId),
      source: decision.source,
      reason: decision.reason,
    });
    if (read.kind === 'manual' && decision.source === 'captions:manual') {
      // A captions result is not cached: the read costs about as much as
      // a cache hit, so it is fetched fresh on every run.
      return captionsTranscript(videoId, read, deps.maxBlockSeconds);
    }
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
