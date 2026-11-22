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

function httpStatusOf(err: unknown): number | undefined {
  if (err && typeof err === 'object') {
    const e = err as { status?: unknown; statusCode?: unknown };
    if (typeof e.status === 'number') return e.status;
    if (typeof e.statusCode === 'number') return e.statusCode;
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
}): GeminiCaller {
  const ai = new GoogleGenAI({
    apiKey: options.apiKey,
    httpOptions: {
      timeout: REQUEST_TIMEOUT_MS,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    },
  });

  return async (request) => {
    // Documented YouTube-URL request shape: one generateContent call whose
    // video part is fileData.fileUri; a partial-range rerun adds
    // videoMetadata.startOffset ("<seconds>s").
    const videoPart: Part = { fileData: { fileUri: request.videoUrl } };
    if (request.startOffsetSeconds !== undefined && request.startOffsetSeconds > 0) {
      videoPart.videoMetadata = { startOffset: `${Number(request.startOffsetSeconds.toFixed(3))}s` };
    }

    try {
      const response = await ai.models.generateContent({
        model: options.model,
        contents: [{ role: 'user', parts: [videoPart, { text: request.prompt }] }],
      });

      const finishReason = response.candidates?.[0]?.finishReason;
      const status = finishReason === FinishReason.MAX_TOKENS ? 'incomplete' : 'completed';
      return { text: response.text ?? '', status };
    } catch (err) {
      throw mapSdkError(err, options.model);
    }
  };
}
