import { TranscriptError } from './errors.js';
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
  log?: (line: string) => void;
}

interface RoundResult extends ParsedModelOutput {
  status: string;
  noMoreContent?: boolean;
}

const MAX_CONTINUATION_ROUNDS = 8;
const EPS = 1e-3;
// A declared video duration is trusted to this tolerance; a shorter gap is
// not worth another request.
const TAIL_TOLERANCE_SECONDS = 1;
// Only a 400 that specifically reports a start offset past the video end
// means "nothing left"; any other 400 is a real failure.
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

  const run = async () => {
    try {
      const res = await request(false);
      return { ...parseModelOutput(res.text, deps.maxBlockSeconds), status: res.status };
    } catch (err) {
      if (err instanceof ModelOutputError) {
        // One retry with a stricter instruction, then give up.
        const res = await request(true);
        try {
          return { ...parseModelOutput(res.text, deps.maxBlockSeconds), status: res.status };
        } catch (second) {
          const detail = second instanceof Error ? second.message : String(second);
          throw new TranscriptError('bad_model_output', `model output not in expected format: ${detail}`);
        }
      }
      throw err;
    }
  };

  try {
    return await run();
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
    err.code === 'video_unavailable' &&
    err.httpStatus === 400 &&
    PAST_END_OFFSET_MESSAGE.test(err.message)
  );
}

function appendNewBlocks(blocks: TranscriptBlock[], incoming: TranscriptBlock[]): number {
  let added = 0;
  for (const b of incoming) {
    const lastEnd = blocks.length > 0 ? blocks[blocks.length - 1].end : -Infinity;
    // Drop repeated or overlapping continuation blocks: new content must
    // start at or after the end of what is already merged.
    if (b.start >= lastEnd - EPS) {
      blocks.push(b);
      added += 1;
    }
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

export async function transcribeVideo(videoId: string, deps: TranscribeDeps): Promise<Transcript> {
  const videoUrl = canonicalVideoUrl(videoId);
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

  for (let round = 0; round <= MAX_CONTINUATION_ROUNDS; round++) {
    const fromSeconds = round === 0 ? undefined : blocks[blocks.length - 1].end;
    const out = await callRound(videoUrl, fromSeconds, deps);

    if (out.language !== 'unknown') language = out.language;
    appendNewBlocks(blocks, out.blocks);

    if (out.noMoreContent) {
      if (blocks.length === 0) {
        throw new TranscriptError('bad_model_output', 'model produced no transcript blocks');
      }
      return result();
    }
    if (blocks.length === 0) {
      throw new TranscriptError('bad_model_output', 'model produced no transcript blocks');
    }

    const lastEnd = blocks[blocks.length - 1].end;
    const truncated = out.status === 'incomplete' || out.status === 'requires_continuation';
    const missingTail =
      out.durationSeconds !== undefined && lastEnd < out.durationSeconds - TAIL_TOLERANCE_SECONDS;

    if (!truncated && !missingTail) return result();
  }

  throw new TranscriptError(
    'bad_model_output',
    `transcript incomplete after ${MAX_CONTINUATION_ROUNDS} continuation requests`,
  );
}

export async function transcribeYouTube(videoId: string, deps: TranscribeDeps): Promise<Transcript> {
  const cached = await readCachedTranscript(deps.cacheDir, videoId, deps.model, deps.maxBlockSeconds);
  if (cached) {
    deps.log?.(`cache hit ${videoId}`);
    return cached;
  }
  const transcript = await transcribeVideo(videoId, deps);
  await writeCachedTranscript(deps.cacheDir, transcript, deps.model, deps.maxBlockSeconds);
  return transcript;
}
