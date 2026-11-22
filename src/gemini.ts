import { FinishReason, GoogleGenAI } from '@google/genai';
import type { Fetch, Part } from '@google/genai';
import { TranscriptError } from './errors.js';

export interface GeminiVideoRequest {
  videoUrl: string;
  prompt: string;
  startOffsetSeconds?: number;
}

export interface GeminiVideoResponse {
  text: string;
  status: string;
}

export type GeminiCaller = (request: GeminiVideoRequest) => Promise<GeminiVideoResponse>;

const REQUEST_TIMEOUT_MS = 15 * 60 * 1000;

// A 400 reports "video cannot be read" only when the upstream message is
// about the video and names an access failure; every other 400 is a
// request-shape problem and maps to upstream_rejected.
const VIDEO_SUBJECT = /video|youtube|media/i;
const VIDEO_ACCESS_FAILURE =
  /private|members?[- ]?only|age[- ]?restrict|removed|deleted|no longer available|inaccessible|not accessible|cannot be accessed|can't be accessed|could not be accessed|unavailable|not found|(could not|couldn't|cannot|can't|unable to|failed to)[^.,;]{0,60}(access|process|read|fetch|load|retrieve|play|download)/i;

// A 400 that calls the media payload itself empty, corrupted or malformed
// is a transient upstream ingestion fault, not an access failure: the same
// call is retried once after a short delay, and only a repeat failure is
// reported to the caller as upstream_media_error.
const MEDIA_DATA = /\b(?:file|media|video|audio)\s+data\b/i;
const MEDIA_DATA_FAULT = /\b(?:empty|corrupt|malformed)\w*/i;
const MEDIA_RETRY_DELAY_MS = 2_000;

function httpStatusOf(err: unknown): number | undefined {
  if (err && typeof err === 'object') {
    if ('status' in err && typeof err.status === 'number') return err.status;
    if ('statusCode' in err && typeof err.statusCode === 'number') return err.statusCode;
  }
  return undefined;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function mapSdkError(err: unknown, model: string): TranscriptError | Error {
  if (err instanceof TranscriptError) return err;

  const status = httpStatusOf(err);
  const message = messageOf(err);
  const name = err instanceof Error ? err.name : '';
  const lower = message.toLowerCase();

  if (status === 400) {
    if (/api.?key|key not valid|key invalid/.test(lower)) {
      return new TranscriptError('key_rejected', `Gemini rejected the API key: ${message}`, { httpStatus: status });
    }
    if (MEDIA_DATA.test(message) && MEDIA_DATA_FAULT.test(message)) {
      return new TranscriptError('upstream_media_error', `Gemini could not process the media data: ${message}`, { httpStatus: status });
    }
    if (VIDEO_SUBJECT.test(message) && VIDEO_ACCESS_FAILURE.test(message)) {
      return new TranscriptError('video_unavailable', `Gemini could not read the video (private, members-only, age-restricted or removed): ${message}`, { httpStatus: status });
    }
    return new TranscriptError('upstream_rejected', `Gemini rejected the request (HTTP 400): ${message}`, { httpStatus: status });
  }
  if (status === 401 || status === 403) {
    return new TranscriptError('key_rejected', `Gemini rejected the API key: ${message}`, { httpStatus: status });
  }
  if (status === 404) {
    if (/model/i.test(message)) {
      return new TranscriptError('model_not_found', `Gemini model '${model}' not found; check GEMINI_MODEL (or config.geminiModel in package.json): ${message}`, { httpStatus: status });
    }
    return new TranscriptError('video_unavailable', `Gemini returned 404 (video or model not found): ${message}`, { httpStatus: status });
  }
  if (status === 429) {
    return new TranscriptError('quota_exceeded', `Gemini quota exceeded: ${message}`, { httpStatus: status });
  }
  if (
    status === 408 ||
    status === 504 ||
    (status !== undefined && status >= 500) ||
    /timeout|timed out|aborterror|timeouterror|econn|enotfound|eai_again|fetch failed|network/.test(lower) ||
    name === 'AbortError' ||
    name === 'TimeoutError' ||
    name === 'ContinuationInterruptedError' ||
    name.startsWith('APIConnection')
  ) {
    return new TranscriptError('upstream_timeout', `Gemini request did not complete: ${message}`, { httpStatus: status });
  }
  if (status !== undefined && status >= 400) {
    return new TranscriptError('video_unavailable', `Gemini error ${status}: ${message}`, { httpStatus: status });
  }
  return err instanceof Error ? err : new Error(message);
}

export function createGeminiCaller(options: {
  apiKey: string;
  model: string;
  fetch?: Fetch;
  sleep?: (ms: number) => Promise<void>;
}): GeminiCaller {
  const ai = new GoogleGenAI({
    apiKey: options.apiKey,
    httpOptions: {
      timeout: REQUEST_TIMEOUT_MS,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    },
  });
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  return async (request) => {
    // Documented YouTube-URL request shape: one generateContent call whose
    // video part is fileData.fileUri; a partial-range rerun adds
    // videoMetadata.startOffset ("<seconds>s").
    const videoPart: Part = { fileData: { fileUri: request.videoUrl } };
    if (request.startOffsetSeconds !== undefined && request.startOffsetSeconds > 0) {
      videoPart.videoMetadata = { startOffset: `${Number(request.startOffsetSeconds.toFixed(3))}s` };
    }

    const generate = async (): Promise<GeminiVideoResponse> => {
      const response = await ai.models.generateContent({
        model: options.model,
        contents: [{ role: 'user', parts: [videoPart, { text: request.prompt }] }],
      });

      const finishReason = response.candidates?.[0]?.finishReason;
      const status = finishReason === FinishReason.MAX_TOKENS ? 'incomplete' : 'completed';
      return { text: response.text ?? '', status };
    };

    try {
      return await generate();
    } catch (err) {
      const mapped = mapSdkError(err, options.model);
      if (!(mapped instanceof TranscriptError) || mapped.code !== 'upstream_media_error') {
        throw mapped;
      }
    }

    // The media-ingestion 400 is transient: the identical call gets one
    // retry after a short delay. A second failure — of the same class or
    // any other — is reported by its own mapped code.
    await sleep(MEDIA_RETRY_DELAY_MS);
    try {
      return await generate();
    } catch (err) {
      throw mapSdkError(err, options.model);
    }
  };
}
