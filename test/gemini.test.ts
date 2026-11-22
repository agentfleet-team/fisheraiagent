import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGeminiCaller } from '../src/gemini.js';
import { TranscriptError } from '../src/errors.js';

const VIDEO_URL = 'https://www.youtube.com/watch?v=hWe-j78vNpc';

interface CapturedRequest {
  url: string;
  body: {
    contents?: Array<{ role?: string; parts?: Array<Record<string, unknown>> }>;
  };
}

interface StubResponse {
  status?: number;
  body: unknown;
}

function stubbedHttp(respond: (request: CapturedRequest) => StubResponse) {
  const requests: CapturedRequest[] = [];
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request: CapturedRequest = {
      url: String(input),
      body: init?.body === undefined ? {} : (JSON.parse(String(init.body)) as CapturedRequest['body']),
    };
    requests.push(request);
    const res = respond(request);
    return new Response(JSON.stringify(res.body), {
      status: res.status ?? 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  return { requests, fetch: fetchImpl };
}

function modelResponse(text: string, finishReason = 'STOP'): StubResponse {
  return {
    body: {
      candidates: [
        {
          content: { role: 'model', parts: [{ text }] },
          finishReason,
        },
      ],
    },
  };
}

function apiError(status: number, message: string): StubResponse {
  return {
    status,
    body: { error: { code: status, message, status: 'INVALID_ARGUMENT' } },
  };
}

function fileUriOf(part: Record<string, unknown>): unknown {
  const fileData = (part.fileData ?? part.file_data) as Record<string, unknown> | undefined;
  return fileData?.fileUri ?? fileData?.file_uri;
}

function startOffsetOf(part: Record<string, unknown>): unknown {
  const metadata = (part.videoMetadata ?? part.video_metadata) as Record<string, unknown> | undefined;
  return metadata?.startOffset ?? metadata?.start_offset;
}

test('the caller sends generateContent with the YouTube URL as fileData.fileUri and the prompt as a text part', async () => {
  const { requests, fetch } = stubbedHttp(() => modelResponse('LANGUAGE: en\n[00:00 - 00:08] hi'));
  const caller = createGeminiCaller({ apiKey: 'test-key', model: 'test-model', fetch });

  const res = await caller({ videoUrl: VIDEO_URL, prompt: 'PROMPT TEXT' });

  assert.equal(requests.length, 1);
  const request = requests[0];
  assert.match(request.url, /:generateContent(\?|$)/);
  assert.doesNotMatch(request.url, /interactions/);

  const parts = request.body.contents?.[0]?.parts ?? [];
  const videoPart = parts.find((p) => fileUriOf(p) !== undefined);
  const textPart = parts.find((p) => typeof p.text === 'string');
  assert.equal(fileUriOf(videoPart ?? {}), VIDEO_URL);
  assert.equal(textPart?.text, 'PROMPT TEXT');
  assert.equal(startOffsetOf(videoPart ?? {}), undefined);
  assert.equal(res.text, 'LANGUAGE: en\n[00:00 - 00:08] hi');
  assert.equal(res.status, 'completed');
});

test('a partial-range rerun carries the start offset in videoMetadata', async () => {
  const { requests, fetch } = stubbedHttp(() => modelResponse('LANGUAGE: en\n[00:40 - 00:48] tail'));
  const caller = createGeminiCaller({ apiKey: 'test-key', model: 'test-model', fetch });

  await caller({ videoUrl: VIDEO_URL, prompt: 'RANGE PROMPT', startOffsetSeconds: 40 });

  const parts = requests[0].body.contents?.[0]?.parts ?? [];
  const videoPart = parts.find((p) => fileUriOf(p) !== undefined);
  assert.equal(fileUriOf(videoPart ?? {}), VIDEO_URL);
  assert.equal(startOffsetOf(videoPart ?? {}), '40s');
});

test('a max-tokens finish maps to an incomplete status', async () => {
  const { fetch } = stubbedHttp(() => modelResponse('LANGUAGE: en\n[0 - 8] a', 'MAX_TOKENS'));
  const caller = createGeminiCaller({ apiKey: 'test-key', model: 'test-model', fetch });
  const res = await caller({ videoUrl: VIDEO_URL, prompt: 'P' });
  assert.equal(res.status, 'incomplete');
});

test('a 400 request-shape error maps to upstream_rejected, not video_unavailable', async () => {
  const { fetch } = stubbedHttp(() =>
    apiError(
      400,
      "The value 'text' is not supported for 'input[1].type' in v1, it is available in v1beta.",
    ),
  );
  const caller = createGeminiCaller({ apiKey: 'test-key', model: 'test-model', fetch });

  await assert.rejects(
    () => caller({ videoUrl: VIDEO_URL, prompt: 'P' }),
    (err: unknown) =>
      err instanceof TranscriptError &&
      err.code === 'upstream_rejected' &&
      err.httpStatus === 400,
  );
});

test('a 400 that says the video cannot be accessed maps to video_unavailable', async () => {
  const { fetch } = stubbedHttp(() =>
    apiError(400, 'The YouTube video is private or no longer available.'),
  );
  const caller = createGeminiCaller({ apiKey: 'test-key', model: 'test-model', fetch });

  await assert.rejects(
    () => caller({ videoUrl: VIDEO_URL, prompt: 'P' }),
    (err: unknown) =>
      err instanceof TranscriptError &&
      err.code === 'video_unavailable' &&
      err.httpStatus === 400,
  );
});

test('a 404 that names the model maps to model_not_found', async () => {
  const { fetch } = stubbedHttp(() =>
    apiError(
      404,
      'models/test-model is not found for API version v1beta, or is not supported for generateContent. Call ListModels to see the list of available models and their supported methods.',
    ),
  );
  const caller = createGeminiCaller({ apiKey: 'test-key', model: 'test-model', fetch });

  await assert.rejects(
    () => caller({ videoUrl: VIDEO_URL, prompt: 'P' }),
    (err: unknown) =>
      err instanceof TranscriptError &&
      err.code === 'model_not_found' &&
      err.httpStatus === 404 &&
      err.message.includes('test-model') &&
      err.message.includes('GEMINI_MODEL'),
  );
});

test('a 404 without a model reference stays video_unavailable', async () => {
  const { fetch } = stubbedHttp(() => apiError(404, 'Requested entity was not found.'));
  const caller = createGeminiCaller({ apiKey: 'test-key', model: 'test-model', fetch });

  await assert.rejects(
    () => caller({ videoUrl: VIDEO_URL, prompt: 'P' }),
    (err: unknown) =>
      err instanceof TranscriptError &&
      err.code === 'video_unavailable' &&
      err.httpStatus === 404,
  );
});
