import { GoogleGenAI } from '@google/genai';
import { DigestError, type DigestErrorCode } from './errors.js';

export interface DigestLlmRequest {
  system: string;
  prompt: string;
}

// One model call: the text the model returned. A failure throws DigestError
// with a fixed code; upstream text never leaves this module.
export type DigestLlm = (request: DigestLlmRequest) => Promise<string>;

const REQUEST_TIMEOUT_MS = 5 * 60 * 1000;

function statusOf(err: unknown): number | undefined {
  if (err && typeof err === 'object') {
    if ('status' in err && typeof err.status === 'number') return err.status;
    if ('statusCode' in err && typeof err.statusCode === 'number') return err.statusCode;
  }
  return undefined;
}

export function llmErrorCode(err: unknown): DigestErrorCode {
  if (err instanceof DigestError) return err.code;
  const status = statusOf(err);
  const message = err instanceof Error ? err.message.toLowerCase() : '';
  if (status === 429) return 'quota_exceeded';
  if (status === 401 || status === 403) return 'key_rejected';
  if (status === 400) return /api.?key|key not valid|key invalid/.test(message) ? 'key_rejected' : 'upstream_rejected';
  if (status === 404) return /model/.test(message) ? 'model_not_found' : 'upstream_rejected';
  if (status === 408 || status === 504 || (status !== undefined && status >= 500)) return 'upstream_timeout';
  if (/timeout|timed out|econn|enotfound|eai_again|fetch failed|network/.test(message)) return 'upstream_timeout';
  if (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')) return 'upstream_timeout';
  return status !== undefined ? 'upstream_rejected' : 'internal_error';
}

export function createGeminiDigestLlm(options: { apiKey: string; model: string }): DigestLlm {
  const ai = new GoogleGenAI({ apiKey: options.apiKey, httpOptions: { timeout: REQUEST_TIMEOUT_MS } });
  return async (request) => {
    try {
      const response = await ai.models.generateContent({
        model: options.model,
        contents: request.prompt,
        config: { systemInstruction: request.system, responseMimeType: 'application/json' },
      });
      return response.text ?? '';
    } catch (err) {
      throw new DigestError(llmErrorCode(err));
    }
  };
}
