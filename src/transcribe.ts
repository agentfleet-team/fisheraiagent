import { TranscriptError } from './errors.js';
import { parseVideoId } from './ids.js';
import { loggerFor, type LogSink } from './log.js';
import type { GeminiCaller } from './gemini.js';
import { ModelOutputError, parseModelOutput, type ParsedModelOutput } from './model-output.js';
import { initialPrompt, rangePrompt, STRICT_RETRY_SUFFIX } from './prompts.js';
import { readCachedTranscript, writeCachedTranscript } from './cache.js';
import { canonicalVideoUrl } from './youtube-url.js';
import type { Transcript, TranscriptBlock } from './transcript.js';

export interface TranscribeDeps {
  caller: GeminiCaller;
  model: string;
  maxBlockSeconds: number;
  cacheDir: string;
  log?: LogSink;
}

interface RoundResult extends ParsedModelOutput {
  status: string;
  noMoreContent?: boolean;
}

const MAX_CONTINUATION_ROUNDS = 8;
const EPS = 1e-3;
// Block times are whole seconds, so boundary rounding can leave a gap of
// about a second between honest adjacent blocks; only a larger hole is
// treated as dropped coverage.
const GAP_TOLERANCE_SECONDS = 2;
// The transcript is complete only when the response itself says so: a
// finished status, no hole in coverage, and a last block that ends a
// sentence. The model's self-reported video duration is never trusted.
const TERMINAL_PUNCTUATION = /\p{Terminal_Punctuation}[\p{Pf}\p{Pe}"']*$/u;
// Only a 400 that specifically reports a start offset past the video end
// means "nothing left"; any other 400 is a real failure. Such a 400 may be
// classified as video_unavailable or upstream_rejected depending on the
// upstream wording; either code ends the video here.
const PAST_END_OFFSET_MESSAGE = /offset|past (the )?end|beyond (the )?(video |end|duration|length)|exceeds? (the )?(video )?(duration|length)/i;

async function callRound(
  videoUrl: string,
  fromSeconds: number | undefined,
  deps: TranscribeDeps,
): Promise<RoundResult> {
  const request = (strict: boolean) => {
    const base =
      fromSeconds === undefined
        ? initialPrompt(deps.maxBlockSeconds)
        : rangePrompt(deps.maxBlockSeconds, fromSeconds);
    return deps.caller({
      videoUrl,
      prompt: strict ? base + STRICT_RETRY_SUFFIX : base,
      startOffsetSeconds: fromSeconds,
    });
  };

  const run = async (): Promise<RoundResult> => {
    const parse = (text: string) =>
      parseModelOutput(text, deps.maxBlockSeconds, { allowEmpty: fromSeconds !== undefined });
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
    // An empty continuation means the model reports no spoken audio left in
    // the requested range; like a past-end offset it ends the video.
    if (fromSeconds !== undefined && out.blocks.length === 0) out.noMoreContent = true;
    return out;
  } catch (err) {
    if (fromSeconds !== undefined && isPastEndOffsetError(err)) {
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

// Insert continuation blocks into uncovered holes and at the tail. A block
// that overlaps coverage we already have is repeated or jittered output and
// is dropped, so merged start and end times stay monotonic.
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

export async function transcribeVideo(videoId: string, deps: TranscribeDeps): Promise<Transcript> {
  const videoUrl = canonicalVideoUrl(videoId);
  const blocks: TranscriptBlock[] = [];
  let language = 'unknown';
  let continueFrom = 0;

  const result = (): Transcript => {
    assertOrderedEnds(blocks);
    return {
      video_id: videoId,
      source_url: videoUrl,
      language,
      blocks,
    };
  };

  for (let round = 0; round <= MAX_CONTINUATION_ROUNDS; round++) {
    const out = await callRound(videoUrl, round === 0 ? undefined : continueFrom, deps);

    if (out.language !== 'unknown') language = out.language;
    const added = mergeNewBlocks(blocks, out.blocks);

    if (out.noMoreContent) {
      if (blocks.length === 0) {
        throw new TranscriptError('bad_model_output', 'model produced no transcript blocks');
      }
      return result();
    }
    if (blocks.length === 0) {
      throw new TranscriptError('bad_model_output', 'model produced no transcript blocks');
    }
    // A continuation that adds nothing new has reached the end of what the
    // model will say; the merged transcript is the best available answer.
    if (round > 0 && added === 0) return result();

    const truncated = out.status === 'incomplete' || out.status === 'requires_continuation';
    const hole = findFirstHole(blocks);
    const endsSentence = TERMINAL_PUNCTUATION.test(blocks[blocks.length - 1].text);

    if (!truncated && hole === undefined && endsSentence) return result();

    // Rerun only the missing range: a hole is re-covered from where coverage
    // broke off, everything else continues from the last block's end.
    continueFrom = hole ?? blocks[blocks.length - 1].end;
  }

  throw new TranscriptError(
    'bad_model_output',
    `transcript incomplete after ${MAX_CONTINUATION_ROUNDS} continuation requests`,
  );
}

export async function transcribeYouTube(videoId: string, deps: TranscribeDeps): Promise<Transcript> {
  const cached = await readCachedTranscript(deps.cacheDir, videoId, deps.model, deps.maxBlockSeconds);
  if (cached) {
    loggerFor(deps.log)('cache_hit', { video: parseVideoId(videoId) });
    return cached;
  }
  const transcript = await transcribeVideo(videoId, deps);
  await writeCachedTranscript(deps.cacheDir, transcript, deps.model, deps.maxBlockSeconds);
  return transcript;
}
