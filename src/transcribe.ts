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
    // A range request past the end of the video is rejected with 400; that
    // means there is nothing left to transcribe.
    if (fromSeconds !== undefined && err instanceof TranscriptError && err.httpStatus === 400) {
      return { language: 'unknown', blocks: [], status: 'completed', noMoreContent: true };
    }
    throw err;
  }
}

function appendNewBlocks(blocks: TranscriptBlock[], incoming: TranscriptBlock[]): number {
  let added = 0;
  for (const b of incoming) {
    const lastStart = blocks.length > 0 ? blocks[blocks.length - 1].start : -Infinity;
    if (b.start > lastStart + EPS) {
      blocks.push(b);
      added += 1;
    }
  }
  return added;
}

export async function transcribeVideo(videoId: string, deps: TranscribeDeps): Promise<Transcript> {
  const videoUrl = canonicalVideoUrl(videoId);
  const blocks: TranscriptBlock[] = [];
  let language = 'unknown';

  const result = (): Transcript => ({
    video_id: videoId,
    source_url: videoUrl,
    language,
    blocks,
  });

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
      out.durationSeconds !== undefined && lastEnd < out.durationSeconds - deps.maxBlockSeconds;

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
