import { GoogleGenAI } from '@google/genai';
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

function mapSdkError(err: unknown): TranscriptError | Error {
  if (err instanceof TranscriptError) return err;

  const status = httpStatusOf(err);
  const message = messageOf(err);
  const name = err instanceof Error ? err.name : '';
  const lower = message.toLowerCase();

  if (status === 400) {
    if (/api.?key|key not valid|key invalid/.test(lower)) {
      return new TranscriptError('key_rejected', `Gemini rejected the API key: ${message}`, { httpStatus: status });
    }
    return new TranscriptError('video_unavailable', `Gemini could not read the video (private, members-only, age-restricted or removed): ${message}`, { httpStatus: status });
  }
  if (status === 401 || status === 403) {
    return new TranscriptError('key_rejected', `Gemini rejected the API key: ${message}`, { httpStatus: status });
  }
  if (status === 404) {
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

export function createGeminiCaller(options: { apiKey: string; model: string }): GeminiCaller {
  const ai = new GoogleGenAI({ apiKey: options.apiKey });

  return async (request) => {
    const video: {
      type: 'video';
      uri: string;
      processing?: { type: 'static'; start_offset: string };
    } =
      request.startOffsetSeconds !== undefined && request.startOffsetSeconds > 0
        ? {
            type: 'video',
            uri: request.videoUrl,
            processing: {
              type: 'static',
              start_offset: `${Number(request.startOffsetSeconds.toFixed(3))}s`,
            },
          }
        : { type: 'video', uri: request.videoUrl };

    try {
      const interaction = await ai.interactions.create(
        {
          model: options.model,
          input: [video, { type: 'text', text: request.prompt }],
        },
        { timeout: REQUEST_TIMEOUT_MS },
      );

      const status = String(interaction.status ?? 'completed');
      if (status === 'budget_exceeded') {
        throw new TranscriptError('quota_exceeded', 'Gemini interaction stopped with status budget_exceeded');
      }
      if (status === 'failed' || status === 'cancelled') {
        throw new TranscriptError('bad_model_output', `Gemini interaction ${status}`);
      }
      return { text: interaction.output_text ?? '', status };
    } catch (err) {
      throw mapSdkError(err);
    }
  };
}
