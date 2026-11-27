import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';
import { checkModelOutput, countChars, fixedLines } from '../src/digest/check.js';
import { parseEpisodeRequest } from '../src/digest/contract.js';
import { DigestJobStore } from '../src/digest/jobs.js';
import { createDigestService } from '../src/digest/service.js';
import type { DigestLlm, DigestLlmRequest } from '../src/digest/llm.js';
import { PODCAST_ZH_TW_10MIN_BAND, buildDraftPrompt, profileFor } from '../src/digest/profile.js';
import type { DigestDrive } from '../src/digest/save.js';
import { TranscriptError } from '../src/errors.js';
import { MAX_DIGEST_LINE_CHARS, parseTenantsJson } from '../src/tenants.js';

const FIXTURES = join(import.meta.dirname, 'fixtures', 'digest');
const fixture = (name: string): string => readFileSync(join(FIXTURES, name), 'utf8');
const requestBody: unknown = JSON.parse(fixture('request.json'));

// A recorded-shape LLM: returns the queued fixture texts in order and counts
// calls. The last text repeats when the queue runs out.
function stubLlm(texts: string[]): { factory: (key: string) => DigestLlm; calls: DigestLlmRequest[]; keys: string[] } {
  const calls: DigestLlmRequest[] = [];
  const keys: string[] = [];
  return {
    calls,
    keys,
    factory: (key) => {
      keys.push(key);
      return async (request) => {
        calls.push(request);
        return texts[Math.min(calls.length - 1, texts.length - 1)];
      };
    },
  };
}

class StubDrive implements DigestDrive {
  readonly files: { id: string; folder: string; name: string; content: string }[] = [];
  async findFileByName(folderId: string, name: string) {
    return this.files.find((f) => f.folder === folderId && f.name === name) ?? null;
  }
  async createFile(folderId: string, name: string, content: string) {
    const file = { id: `stub-file-${this.files.length + 1}`, folder: folderId, name, content };
    this.files.push(file);
    return { id: file.id, name };
  }
}

async function withService<T>(
  options: Parameters<typeof createDigestService>[0],
  fn: (base: string) => Promise<T>,
): Promise<T> {
  const server: Server = createDigestService(options);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  try {
    return await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
}

async function post(base: string, body: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${base}/v1/jobs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-gemini-key': 'test-key', ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

async function settle(base: string, jobId: string): Promise<Record<string, any>> {
  for (let i = 0; i < 200; i++) {
    const res = await fetch(`${base}/v1/jobs/${jobId}`);
    const view = (await res.json()) as Record<string, any>;
    if (view.status === 'done' || view.status === 'failed') return view;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('job did not settle');
}

const withMissingSlot3 = (): unknown => {
  const req = JSON.parse(fixture('request.json'));
  req.sources = req.sources.filter((s: { slot: number }) => s.slot !== 3);
  req.missing_slots = [3];
  return req;
};

test('D1: POST /v1/jobs with a valid EpisodeRequest returns 202 and GET returns done with an EpisodeScript', async () => {
  const llm = stubLlm([fixture('model-good.json')]);
  await withService({ llmFactory: llm.factory }, async (base) => {
    const sent = await post(base, requestBody);
    assert.equal(sent.status, 202);
    const view = await settle(base, sent.body.job_id);
    assert.equal(view.status, 'done');
    const script = view.result;
    assert.equal(script.profile, 'podcast-zh-tw-10min');
    assert.deepEqual(
      script.sections.map((s: { id: string }) => s.id),
      ['opening', 's1', 's2', 's3', 'closing'],
    );
    const segment = script.sections[1];
    assert.equal(segment.kind, 'segment');
    assert.equal(segment.slot, 1);
    assert.equal(segment.video_id, 'aaaaaaaaaaa');
    assert.ok(segment.refs.length >= 1);
    const { min, max } = profileFor('podcast-zh-tw-10min')!.lengthBand;
    assert.ok(script.char_count >= min && script.char_count <= max);
    assert.equal(script.saved, undefined);
    for (const src of (requestBody as { sources: { title: string; channel: string; url: string }[] }).sources) {
      assert.ok(script.markdown.includes(src.title));
      assert.ok(script.markdown.includes(src.channel));
      assert.ok(script.markdown.includes(src.url));
    }
    assert.equal(llm.calls.length, 1);
  });
});

test('D2: an invalid request returns 400 invalid_request and calls no LLM', async () => {
  const llm = stubLlm([fixture('model-good.json')]);
  await withService({ llmFactory: llm.factory }, async (base) => {
    const bad: unknown[] = [
      {},
      { ...(requestBody as object), profile: 'no-such-profile' },
      { ...(requestBody as object), date: '2026-13-40' },
      { ...(requestBody as object), sources: [] },
      { ...(requestBody as object), missing_slots: [1] },
    ];
    for (const body of bad) {
      const sent = await post(base, body);
      assert.equal(sent.status, 400);
      assert.equal(sent.body.error.code, 'invalid_request');
    }
    const notJson = await fetch(`${base}/v1/jobs`, { method: 'POST', body: '{nope', headers: { 'x-gemini-key': 'k' } });
    assert.equal(notJson.status, 400);
    assert.equal(llm.calls.length, 0);
    assert.equal(llm.keys.length, 0);
  });
});

test('D3: a missing ref triggers exactly one repair call, and a repaired output ends done', async () => {
  const llm = stubLlm([fixture('model-no-ref.json'), fixture('model-good.json')]);
  await withService({ llmFactory: llm.factory }, async (base) => {
    const sent = await post(base, requestBody);
    const view = await settle(base, sent.body.job_id);
    assert.equal(view.status, 'done');
    assert.equal(llm.calls.length, 2);
    assert.ok(llm.calls[1].prompt.includes('沒有 refs'));
  });
});

test('D3: an output outside the length band is repaired twice; a third failure ends failed with script_check_failed', async () => {
  const llm = stubLlm([fixture('model-short.json'), fixture('model-short.json')]);
  await withService({ llmFactory: llm.factory }, async (base) => {
    const sent = await post(base, requestBody);
    const view = await settle(base, sent.body.job_id);
    assert.equal(view.status, 'failed');
    assert.equal(view.error.code, 'script_check_failed');
    assert.equal(view.result, undefined);
    assert.equal(llm.calls.length, 3);
  });
});

// model-good.json with its last segment grown or cut so the spoken text has `chars` characters.
function withCharCount(chars: number): string {
  const out = JSON.parse(fixture('model-good.json'));
  const last = out.sections[out.sections.length - 2];
  const total = (out.sections as { text: string }[]).reduce((n, sec) => n + sec.text.replace(/\s/g, '').length, 0);
  const keep = last.text.replace(/\s/g, '').length + (chars - total);
  last.text = '字'.repeat(keep);
  return JSON.stringify(out);
}

test('C1: the podcast-zh-tw-10min band is 2,400 to 2,850 characters', () => {
  assert.deepEqual(PODCAST_ZH_TW_10MIN_BAND, { min: 2400, max: 2850 });
  assert.deepEqual(profileFor('podcast-zh-tw-10min')!.lengthBand, { min: 2400, max: 2850 });
});

test('D3: the band edges pass the check; one character outside each edge is repaired', async () => {
  const request = parseEpisodeRequest(requestBody)!;
  const profile = profileFor('podcast-zh-tw-10min')!;
  for (const inside of [2400, 2600, 2800, 2850]) {
    const checked = checkModelOutput(request, profile, withCharCount(inside));
    assert.ok(checked.ok, `${inside} passes`);
    assert.equal(checked.script.char_count, inside);
  }
  for (const outside of [2399, 2851]) {
    const llm = stubLlm([withCharCount(outside), fixture('model-good.json')]);
    await withService({ llmFactory: llm.factory }, async (base) => {
      const sent = await post(base, requestBody);
      const view = await settle(base, sent.body.job_id);
      assert.equal(view.status, 'done');
      assert.equal(llm.calls.length, 2);
      assert.ok(llm.calls[1].prompt.includes('必須在 2400 到 2850 字之間'));
    });
  }
});

test('C2: the job passes at attempt 1, 2 or 3 and then makes no further call; a job that never passes makes 3 calls', async () => {
  const bad = fixture('model-no-ref.json');
  const good = fixture('model-good.json');
  const cases: { texts: string[]; status: string; calls: number }[] = [
    { texts: [good], status: 'done', calls: 1 },
    { texts: [bad, good], status: 'done', calls: 2 },
    { texts: [bad, bad, good], status: 'done', calls: 3 },
    { texts: [bad], status: 'failed', calls: 3 },
  ];
  for (const c of cases) {
    const llm = stubLlm(c.texts);
    await withService({ llmFactory: llm.factory }, async (base) => {
      const sent = await post(base, requestBody);
      const view = await settle(base, sent.body.job_id);
      assert.equal(view.status, c.status);
      assert.equal(llm.calls.length, c.calls);
    });
  }
});

test('C2: each repair prompt names the problems of the check before it', async () => {
  const llm = stubLlm([fixture('model-no-ref.json'), fixture('model-short.json'), fixture('model-good.json')]);
  await withService({ llmFactory: llm.factory }, async (base) => {
    const sent = await post(base, requestBody);
    const view = await settle(base, sent.body.job_id);
    assert.equal(view.status, 'done');
    assert.equal(llm.calls.length, 3);
    assert.ok(llm.calls[1].prompt.includes('沒有 refs'));
    assert.ok(!llm.calls[2].prompt.includes('沒有 refs'));
    assert.ok(llm.calls[2].prompt.includes('必須在 2400 到 2850 字之間'));
  });
});

test('C3: a failed job carries the last problems, and the log has one line per failed check', async () => {
  const llm = stubLlm([fixture('model-no-ref.json'), fixture('model-no-ref.json'), fixture('model-short.json')]);
  const lines: string[] = [];
  const store = new DigestJobStore({ llmFactory: llm.factory, logSink: (l) => lines.push(l) });
  const outcome = store.submit(parseEpisodeRequest(requestBody)!, 'SECRET-GEMINI-KEY', undefined);
  assert.equal(outcome.kind, 'accepted');
  const jobId = (outcome as { jobId: string }).jobId;
  let view = store.get(jobId)!;
  for (let i = 0; i < 200 && view.status !== 'failed' && view.status !== 'done'; i++) {
    await new Promise((r) => setTimeout(r, 10));
    view = store.get(jobId)!;
  }
  assert.equal(view.status, 'failed');
  assert.equal(view.error?.code, 'script_check_failed');
  assert.equal(view.error?.problems?.length, 1);
  assert.match(view.error!.problems![0], /必須在 2400 到 2850 字之間/);
  assert.equal(lines.length, 3);
  lines.forEach((line, i) => {
    assert.ok(line.startsWith(`digest_check_failed job=${jobId} attempt=${i + 1} problems=`));
    assert.ok(!line.includes('\n'));
    assert.ok(!line.includes('SECRET-GEMINI-KEY'));
  });
  assert.match(lines[0], /沒有 refs/);
  assert.match(lines[2], /必須在 2400 到 2850 字之間/);
  const transcriptText = parseEpisodeRequest(requestBody)!.sources[0].transcript.blocks[0].text;
  for (const line of lines) assert.ok(!line.includes(transcriptText));
});

test('D3: output that is not JSON counts as a failed check and gets repair calls', async () => {
  const llm = stubLlm(['not json at all', fixture('model-no-ref.json')]);
  await withService({ llmFactory: llm.factory }, async (base) => {
    const sent = await post(base, requestBody);
    const view = await settle(base, sent.body.job_id);
    assert.equal(view.status, 'failed');
    assert.equal(view.error.code, 'script_check_failed');
    assert.equal(llm.calls.length, 3);
  });
});

test('D3: a ref that points outside the transcript fails the check', () => {
  const request = parseEpisodeRequest(requestBody)!;
  const out = JSON.parse(fixture('model-good.json'));
  out.sections[1].refs = [{ video_id: 'aaaaaaaaaaa', start: 99999 }];
  const result = checkModelOutput(request, profileFor('podcast-zh-tw-10min')!, JSON.stringify(out));
  assert.equal(result.ok, false);
});

test('C3: a problem about an invalid ref never contains the model-supplied video_id', () => {
  const request = parseEpisodeRequest(requestBody)!;
  const out = JSON.parse(fixture('model-good.json'));
  const canary = 'CANARY-ref-value-xyz';
  out.sections[1].refs = [{ video_id: canary, start: 12 }];
  const result = checkModelOutput(request, profileFor('podcast-zh-tw-10min')!, JSON.stringify(out));
  assert.equal(result.ok, false);
  if (result.ok) return;
  const joined = result.problems.join('\n');
  assert.ok(!joined.includes(canary));
  assert.match(joined, /slot 1 的 ref（時間 12）不在該來源的逐字稿時間內，因為 video_id 與該來源不符/);
});

test('D4: the same Idempotency-Key twice makes one LLM call and returns the same result', async () => {
  const llm = stubLlm([fixture('model-good.json')]);
  await withService({ llmFactory: llm.factory }, async (base) => {
    const headers = { 'idempotency-key': '2026-11-28/digest' };
    const a = await post(base, requestBody, headers);
    const b = await post(base, requestBody, headers);
    assert.equal(a.status, 202);
    assert.equal(b.status, 202);
    assert.equal(b.body.job_id, a.body.job_id);
    const first = await settle(base, a.body.job_id);
    const second = await settle(base, b.body.job_id);
    assert.deepEqual(second, first);
    assert.equal(llm.calls.length, 1);

    const other = await post(base, { ...(requestBody as object), date: '2026-11-29' }, headers);
    assert.equal(other.status, 409);
    assert.equal(other.body.error.code, 'idempotency_conflict');
    assert.equal(llm.calls.length, 1);
  });
});

test('D4: a replayed Idempotency-Key needs no Gemini key and starts no job', async () => {
  const llm = stubLlm([fixture('model-good.json')]);
  await withService({ llmFactory: llm.factory }, async (base) => {
    const headers = { 'idempotency-key': 'k-1' };
    const a = await post(base, requestBody, headers);
    const b = await post(base, requestBody, { ...headers, 'x-gemini-key': '' });
    assert.equal(b.body.job_id, a.body.job_id);
    await settle(base, a.body.job_id);
    assert.equal(llm.calls.length, 1);
  });
});

test('D5: missing_slots [3] produces two segments and a sentence naming slot 3', async () => {
  const llm = stubLlm([fixture('model-missing-slot3.json')]);
  await withService({ llmFactory: llm.factory }, async (base) => {
    const sent = await post(base, withMissingSlot3());
    const view = await settle(base, sent.body.job_id);
    assert.equal(view.status, 'done');
    const segments = view.result.sections.filter((s: { kind: string }) => s.kind === 'segment');
    assert.deepEqual(segments.map((s: { slot: number }) => s.slot), [1, 2]);
    assert.match(view.result.sections[0].text, /第3則/);
    assert.equal(llm.calls.length, 1);
  });
});

test('D5: a script that does not name the missing slot fails the check', () => {
  const request = parseEpisodeRequest(withMissingSlot3())!;
  const out = JSON.parse(fixture('model-missing-slot3.json'));
  out.sections[0].text = '各位早安，歡迎收聽。';
  const result = checkModelOutput(request, profileFor('podcast-zh-tw-10min')!, JSON.stringify(out));
  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.problems.some((p) => p.includes('第3則')));
});

const tenantsJson = JSON.stringify({
  tenants: [
    {
      id: 'tenant-lines',
      caller: { token_env: 'DIGEST_TEST_CALLER_TOKEN' },
      gemini_key_env: 'DIGEST_TEST_GEMINI_KEY',
      destination: { type: 'google-drive', folder_id: 'folderAkina1' },
    },
  ],
});

test('D6: with no Drive destination configured the job is done and saved is absent', async () => {
  const llm = stubLlm([fixture('model-good.json')]);
  const drive = new StubDrive();
  await withService({ llmFactory: llm.factory, drive }, async (base) => {
    const sent = await post(base, requestBody);
    const view = await settle(base, sent.body.job_id);
    assert.equal(view.status, 'done');
    assert.equal(view.result.saved, undefined);
    assert.equal(drive.files.length, 0);
  });
});

test('D6: with a destination configured save creates <date>-script.md, and an existing file of that name is reused', async () => {
  process.env.DIGEST_TEST_CALLER_TOKEN = 'caller-token-for-test';
  process.env.DIGEST_TEST_GEMINI_KEY = 'tenant-key-for-test';
  try {
    const llm = stubLlm([fixture('model-good.json')]);
    const drive = new StubDrive();
    await withService({ llmFactory: llm.factory, drive, tenantsJson }, async (base) => {
      const auth = { authorization: 'Bearer caller-token-for-test', 'x-gemini-key': '' };
      const first = await settle(base, (await post(base, requestBody, auth)).body.job_id);
      assert.equal(first.status, 'done');
      assert.deepEqual(first.result.saved, { file_id: 'stub-file-1', name: '2026-11-28-script.md' });
      assert.equal(drive.files.length, 1);
      assert.equal(drive.files[0].folder, 'folderAkina1');
      assert.equal(drive.files[0].content, first.result.markdown);
      assert.deepEqual(llm.keys, ['tenant-key-for-test']);

      // A second job for the same date, without an Idempotency-Key: the
      // file of that name exists, so its id comes back and nothing is created.
      const second = await settle(base, (await post(base, requestBody, auth)).body.job_id);
      assert.deepEqual(second.result.saved, { file_id: 'stub-file-1', name: '2026-11-28-script.md' });
      assert.equal(drive.files.length, 1);
    });
  } finally {
    delete process.env.DIGEST_TEST_CALLER_TOKEN;
    delete process.env.DIGEST_TEST_GEMINI_KEY;
  }
});

test('D6: a Drive failure leaves the job done and reports save_failed', async () => {
  const drive: DigestDrive = {
    findFileByName: async () => {
      throw new Error('drive down');
    },
    createFile: async () => {
      throw new Error('drive down');
    },
  };
  process.env.DIGEST_TEST_CALLER_TOKEN = 'caller-token-for-test';
  try {
    const llm = stubLlm([fixture('model-good.json')]);
    await withService({ llmFactory: llm.factory, drive, tenantsJson }, async (base) => {
      const auth = { authorization: 'Bearer caller-token-for-test' };
      const view = await settle(base, (await post(base, requestBody, auth)).body.job_id);
      assert.equal(view.status, 'done');
      assert.equal(view.result.saved, undefined);
      assert.equal(view.save_error.code, 'save_failed');
    });
  } finally {
    delete process.env.DIGEST_TEST_CALLER_TOKEN;
  }
});

test('auth: SERVICE_TOKEN guards /v1, a keyless request is 400 missing_key, an unknown job is 404', async () => {
  const llm = stubLlm([fixture('model-good.json')]);
  await withService({ llmFactory: llm.factory, serviceToken: 'svc-token-for-test' }, async (base) => {
    assert.equal((await fetch(`${base}/healthz`)).status, 200);
    assert.equal((await post(base, requestBody)).status, 401);
    const auth = { authorization: 'Bearer svc-token-for-test' };
    const keyless = await post(base, requestBody, { ...auth, 'x-gemini-key': '' });
    assert.equal(keyless.status, 400);
    assert.equal(keyless.body.error.code, 'missing_key');
    const missing = await fetch(`${base}/v1/jobs/00000000-0000-4000-8000-000000000000`, { headers: auth });
    assert.equal(missing.status, 404);
    assert.equal(llm.calls.length, 0);
  });
});

test('an LLM failure ends the job failed with its fixed code and no repair call', async () => {
  const { DigestError } = await import('../src/digest/errors.js');
  let calls = 0;
  const factory = (): DigestLlm => async () => {
    calls += 1;
    throw new DigestError('quota_exceeded');
  };
  await withService({ llmFactory: factory }, async (base) => {
    const view = await settle(base, (await post(base, requestBody)).body.job_id);
    assert.equal(view.status, 'failed');
    assert.equal(view.error.code, 'quota_exceeded');
    assert.equal(calls, 1);
  });
});

// --- tenant digest lines: fixed opening_line / closing_line (invented test values) ---

const OPEN_LINE = '測試租戶專用開場台詞，節目開始。';
const CLOSE_LINE = '測試租戶專用收尾台詞，節目結束。';
// What a well-behaved model writes under fixed lines: no greeting, no sign-off.
const MODEL_OPENING = '今天三支影片的重點整理，直接開始。';
const MODEL_CLOSING = '以上是今天的內容。';

// model-good.json with the opening and closing texts replaced and the last
// segment grown or cut so the model's own text has `modelChars` characters.
function withFraming(openingText: string, closingText: string, modelChars: number): string {
  const out = JSON.parse(fixture('model-good.json'));
  out.sections[0].text = openingText;
  out.sections[out.sections.length - 1].text = closingText;
  const seg = out.sections[out.sections.length - 2];
  const rest = (out.sections as { text: string }[])
    .filter((_, i) => i !== out.sections.length - 2)
    .reduce((n, s) => n + s.text.replace(/\s/g, '').length, 0);
  seg.text = '字'.repeat(modelChars - rest);
  return JSON.stringify(out);
}

test('L4: the tenant digest field parses opening_line and closing_line; absent stays undefined', () => {
  const doc = (digest?: unknown) =>
    JSON.stringify({ tenants: [{ id: 'pod', ...(digest === undefined ? {} : { digest }) }] });
  assert.equal(parseTenantsJson(doc(), 'test')[0].digest, undefined);
  assert.deepEqual(parseTenantsJson(doc({}), 'test')[0].digest, {});
  assert.deepEqual(
    parseTenantsJson(doc({ opening_line: '甲', closing_line: '乙' }), 'test')[0].digest,
    { opening_line: '甲', closing_line: '乙' },
  );
  assert.deepEqual(
    parseTenantsJson(doc({ opening_line: ' 甲', closing_line: '乙 ' }), 'test')[0].digest,
    { opening_line: ' 甲', closing_line: '乙 ' },
  );
  assert.equal(
    parseTenantsJson(doc({ opening_line: '字'.repeat(MAX_DIGEST_LINE_CHARS) }), 'test')[0].digest?.opening_line
      ?.length,
    MAX_DIGEST_LINE_CHARS,
  );
});

test('L4: the tenants document rejects a bad digest field with invalid_config', () => {
  const bad: unknown[] = [
    'yes',
    3,
    { opening_line: 3 },
    { opening_line: '' },
    { opening_line: '   ' },
    { closing_line: true },
    { closing_line: { text: 'x' } },
    { opening_line: '字'.repeat(MAX_DIGEST_LINE_CHARS + 1) },
    { closing_line: '字'.repeat(MAX_DIGEST_LINE_CHARS + 1) },
  ];
  for (const digest of bad) {
    assert.throws(
      () => parseTenantsJson(JSON.stringify({ tenants: [{ id: 'pod', digest }] }), 'test'),
      (err: unknown) => err instanceof TranscriptError && err.code === 'invalid_config',
      JSON.stringify(digest),
    );
  }
});

test('L2: the fixed lines wrap the opening and closing verbatim and count in char_count', () => {
  const request = parseEpisodeRequest(requestBody)!;
  const profile = profileFor('podcast-zh-tw-10min')!;
  const lines = fixedLines({ opening_line: OPEN_LINE, closing_line: CLOSE_LINE })!;
  const modelChars = 2400 - lines.chars;
  const checked = checkModelOutput(request, profile, withFraming(MODEL_OPENING, MODEL_CLOSING, modelChars), lines);
  assert.ok(checked.ok);
  const { sections } = checked.script;
  assert.equal(sections[0].text, `${OPEN_LINE}\n${MODEL_OPENING}`);
  assert.equal(sections[sections.length - 1].text, `${MODEL_CLOSING}\n${CLOSE_LINE}`);
  assert.equal(checked.script.char_count, modelChars + lines.chars);
  assert.equal(checked.script.char_count, 2400);
});

test('L2: a model greeting or sign-off is a problem, not kept beside the fixed lines', () => {
  const request = parseEpisodeRequest(requestBody)!;
  const profile = profileFor('podcast-zh-tw-10min')!;
  const lines = fixedLines({ opening_line: OPEN_LINE, closing_line: CLOSE_LINE })!;
  const greeted = checkModelOutput(request, profile, withFraming(`各位聽眾早安！${MODEL_OPENING}`, MODEL_CLOSING, 2500), lines);
  assert.ok(!greeted.ok);
  assert.ok(greeted.problems.some((p) => p.includes('問候語')));
  const signed = checkModelOutput(request, profile, withFraming(MODEL_OPENING, `${MODEL_CLOSING}再見，下集見！`, 2500), lines);
  assert.ok(!signed.ok);
  assert.ok(signed.problems.some((p) => p.includes('道別語')));
  // a tenant without lines keeps the old behavior
  assert.ok(checkModelOutput(request, profile, withFraming(`各位聽眾早安！${MODEL_OPENING}`, MODEL_CLOSING, 2500)).ok);
});

test('L2: a noncompliant first draft is repaired; the result has no duplicate framing and exact whitespace', async () => {
  process.env.DIGEST_TEST_CALLER_TOKEN = 'caller-token-for-test';
  const opening = `  ${OPEN_LINE}`;
  const closing = `${CLOSE_LINE}  `;
  const tenants = JSON.stringify({
    tenants: [
      { id: 'tenant-lines', caller: { token_env: 'DIGEST_TEST_CALLER_TOKEN' }, digest: { opening_line: opening, closing_line: closing } },
    ],
  });
  try {
    const llm = stubLlm([
      withFraming(`各位聽眾早安！${MODEL_OPENING}`, `${MODEL_CLOSING}再見，下集見！`, 2500),
      withFraming(MODEL_OPENING, MODEL_CLOSING, 2500),
    ]);
    await withService({ llmFactory: llm.factory, tenantsJson: tenants }, async (base) => {
      const sent = await post(base, requestBody, { authorization: 'Bearer caller-token-for-test' });
      const view = await settle(base, sent.body.job_id);
      assert.equal(view.status, 'done');
      assert.equal(llm.calls.length, 2);
      const sections = view.result.sections;
      assert.equal(sections[0].text, `${opening}\n${MODEL_OPENING}`);
      assert.equal(sections[sections.length - 1].text, `${MODEL_CLOSING}\n${closing}`);
    });
  } finally {
    delete process.env.DIGEST_TEST_CALLER_TOKEN;
  }
});

test('L2: a body that echoes a fixed line is a problem, not deduplicated silently', () => {
  const request = parseEpisodeRequest(requestBody)!;
  const profile = profileFor('podcast-zh-tw-10min')!;
  const lines = fixedLines({ opening_line: OPEN_LINE, closing_line: CLOSE_LINE })!;
  // no greeting or sign-off keywords: only the echo can fail this draft
  const echoed = checkModelOutput(
    request,
    profile,
    withFraming(`${OPEN_LINE}\n${MODEL_OPENING}`, `${MODEL_CLOSING}\n${CLOSE_LINE}`, 2500),
    lines,
  );
  assert.ok(!echoed.ok);
  assert.ok(echoed.problems.some((p) => p.includes('重複寫出固定台詞')));
});

test('L2: a fixed line echoed in the other framing body is a problem', () => {
  const request = parseEpisodeRequest(requestBody)!;
  const profile = profileFor('podcast-zh-tw-10min')!;
  const lines = fixedLines({ opening_line: OPEN_LINE, closing_line: CLOSE_LINE })!;
  const closingInOpening = checkModelOutput(
    request,
    profile,
    withFraming(`${MODEL_OPENING}\n${CLOSE_LINE}`, MODEL_CLOSING, 2500),
    lines,
  );
  assert.ok(!closingInOpening.ok);
  assert.ok(closingInOpening.problems.some((p) => p.includes('收尾台詞')));
  const openingInClosing = checkModelOutput(
    request,
    profile,
    withFraming(MODEL_OPENING, `${OPEN_LINE}\n${MODEL_CLOSING}`, 2500),
    lines,
  );
  assert.ok(!openingInClosing.ok);
  assert.ok(openingInClosing.problems.some((p) => p.includes('開場台詞')));
});

test('L3: the fixed lines count toward the length band', () => {
  const request = parseEpisodeRequest(requestBody)!;
  const profile = profileFor('podcast-zh-tw-10min')!;
  const lines = fixedLines({ opening_line: OPEN_LINE, closing_line: CLOSE_LINE })!;
  for (const total of [2400, 2850]) {
    const checked = checkModelOutput(
      request,
      profile,
      withFraming(MODEL_OPENING, MODEL_CLOSING, total - lines.chars),
      lines,
    );
    assert.ok(checked.ok, `${total} passes`);
    assert.equal(checked.script.char_count, total);
  }
  for (const total of [2399, 2851]) {
    const checked = checkModelOutput(
      request,
      profile,
      withFraming(MODEL_OPENING, MODEL_CLOSING, total - lines.chars),
      lines,
    );
    assert.equal(checked.ok, false, `${total} fails`);
    if (!checked.ok) {
      assert.ok(checked.problems.some((p) => p.includes('必須在 2400 到 2850 字之間')));
    }
  }
});

test('L2/L3: with fixed lines the prompt shrinks the model target and says the system adds them', () => {
  const request = parseEpisodeRequest(requestBody)!;
  const profile = profileFor('podcast-zh-tw-10min')!;
  const chars = countChars([OPEN_LINE, CLOSE_LINE]);
  const prompt = buildDraftPrompt(profile, request, fixedLines({ opening_line: OPEN_LINE, closing_line: CLOSE_LINE }));
  assert.ok(prompt.includes(`${2400 - chars} 到 ${2850 - chars} 字`));
  assert.ok(prompt.includes('固定台詞'));
  assert.ok(prompt.includes('不要寫問候語'));
  assert.ok(prompt.includes('不要寫收尾'));
  const openingOnly = buildDraftPrompt(profile, request, fixedLines({ opening_line: OPEN_LINE }));
  assert.ok(openingOnly.includes('不要寫問候語'));
  assert.ok(!openingOnly.includes('收尾署名'));
  // a tenant without lines gets the same prompt as no lines at all
  assert.equal(buildDraftPrompt(profile, request, fixedLines({})), buildDraftPrompt(profile, request));
});

const tenantsWithLines = JSON.stringify({
  tenants: [
    {
      id: 'tenant-lines',
      caller: { token_env: 'DIGEST_TEST_CALLER_TOKEN' },
      digest: { opening_line: OPEN_LINE, closing_line: CLOSE_LINE },
    },
  ],
});

test('L2/L3: a job for a tenant with digest lines returns them verbatim and budgets around them', async () => {
  process.env.DIGEST_TEST_CALLER_TOKEN = 'caller-token-for-test';
  try {
    const llm = stubLlm([withFraming(MODEL_OPENING, MODEL_CLOSING, 2500)]);
    await withService({ llmFactory: llm.factory, tenantsJson: tenantsWithLines }, async (base) => {
      const sent = await post(base, requestBody, { authorization: 'Bearer caller-token-for-test' });
      assert.equal(sent.status, 202);
      const view = await settle(base, sent.body.job_id);
      assert.equal(view.status, 'done');
      const sections = view.result.sections;
      assert.equal(sections[0].text, `${OPEN_LINE}\n${MODEL_OPENING}`);
      assert.equal(sections[sections.length - 1].text, `${MODEL_CLOSING}\n${CLOSE_LINE}`);
      const fixed = countChars([OPEN_LINE, CLOSE_LINE]);
      assert.equal(view.result.char_count, 2500 + fixed);
      assert.ok(view.result.markdown.includes(OPEN_LINE));
      assert.ok(view.result.markdown.includes(CLOSE_LINE));
      const prompt = llm.calls[0].prompt;
      assert.ok(prompt.includes(`${2400 - fixed} 到 ${2850 - fixed} 字`));
      assert.ok(prompt.includes('不要寫問候語'));
      assert.ok(prompt.includes('不要寫收尾'));
      assert.equal(llm.calls.length, 1);
    });
  } finally {
    delete process.env.DIGEST_TEST_CALLER_TOKEN;
  }
});

test('L2: a job repairs a draft that echoes the fixed lines; each lands once', async () => {
  process.env.DIGEST_TEST_CALLER_TOKEN = 'caller-token-for-test';
  try {
    const llm = stubLlm([
      withFraming(`${OPEN_LINE}\n${MODEL_OPENING}`, `${MODEL_CLOSING}\n${CLOSE_LINE}`, 2500),
      withFraming(MODEL_OPENING, MODEL_CLOSING, 2500),
    ]);
    await withService({ llmFactory: llm.factory, tenantsJson: tenantsWithLines }, async (base) => {
      const sent = await post(base, requestBody, { authorization: 'Bearer caller-token-for-test' });
      const view = await settle(base, sent.body.job_id);
      assert.equal(view.status, 'done');
      assert.equal(llm.calls.length, 2);
      const sections = view.result.sections;
      assert.equal(sections[0].text, `${OPEN_LINE}\n${MODEL_OPENING}`);
      assert.equal(sections[sections.length - 1].text, `${MODEL_CLOSING}\n${CLOSE_LINE}`);
    });
  } finally {
    delete process.env.DIGEST_TEST_CALLER_TOKEN;
  }
});

// --- length control: concrete target, per-section budget, richer repair problem ---

test('N1: the draft prompt states a concrete character target and a per-section budget', () => {
  const request = parseEpisodeRequest(requestBody)!;
  const profile = profileFor('podcast-zh-tw-10min')!;
  const prompt = buildDraftPrompt(profile, request);
  assert.ok(prompt.includes('你的文字合計約 2625 字'));
  assert.ok(prompt.includes('opening 約 120 字'));
  assert.ok(prompt.includes('每個 segment 約 808 字'));
  assert.ok(prompt.includes('closing 約 80 字'));
  // fixed framing lines spend part of the band, so the model's own target shrinks
  const lines = fixedLines({ opening_line: OPEN_LINE, closing_line: CLOSE_LINE })!;
  const ownTarget = 2625 - lines.chars;
  const withLines = buildDraftPrompt(profile, request, lines);
  assert.ok(withLines.includes(`你的文字合計約 ${ownTarget} 字`));
  assert.ok(withLines.includes(`每個 segment 約 ${Math.round((ownTarget - 200) / 3)} 字`));
});

test('N2: an overlong draft gets a repair prompt naming the total, the exact overshoot and per-section cuts', async () => {
  const llm = stubLlm([withCharCount(3100), fixture('model-good.json')]);
  await withService({ llmFactory: llm.factory }, async (base) => {
    const sent = await post(base, requestBody);
    const view = await settle(base, sent.body.job_id);
    assert.equal(view.status, 'done');
    assert.equal(llm.calls.length, 2);
    const repair = llm.calls[1].prompt;
    assert.ok(repair.includes('全部文字合計 3100 字'));
    assert.ok(repair.includes('必須在 2400 到 2850 字之間'));
    assert.ok(repair.includes('超出上限 250 字'));
    assert.ok(repair.includes('請縮減到合計約 2625 字'));
    assert.ok(repair.includes('opening 目前'));
    assert.ok(repair.includes('slot 1 目前'));
    assert.ok(repair.includes('slot 3 目前'));
    assert.ok(repair.includes('closing 目前'));
    assert.ok(repair.includes('→ 約'));
  });
});

test('N2: an underlong draft names the exact shortfall and a per-section add toward the midpoint', () => {
  const request = parseEpisodeRequest(requestBody)!;
  const checked = checkModelOutput(request, profileFor('podcast-zh-tw-10min')!, withCharCount(2000));
  assert.equal(checked.ok, false);
  if (checked.ok) return;
  const problem = checked.problems.find((p) => p.includes('必須在'))!;
  assert.ok(problem.includes('全部文字合計 2000 字'));
  assert.ok(problem.includes('不足下限 400 字'));
  assert.ok(problem.includes('請擴寫到合計約 2625 字'));
  assert.ok(problem.includes('opening 目前'));
  assert.ok(problem.includes('closing 目前'));
});

test('N2: a draft with no countable text gets per-section targets that sum to the midpoint', () => {
  const request = parseEpisodeRequest(requestBody)!;
  const blank = JSON.parse(fixture('model-good.json')) as { sections: { text: string }[] };
  for (const sec of blank.sections) sec.text = ' \n ';
  const checked = checkModelOutput(request, profileFor('podcast-zh-tw-10min')!, JSON.stringify(blank));
  assert.equal(checked.ok, false);
  if (checked.ok) return;
  const problem = checked.problems.find((p) => p.includes('必須在'))!;
  assert.ok(problem.includes('全部文字合計 0 字'));
  assert.ok(problem.includes('不足下限 2400 字'));
  const targets = [...problem.matchAll(/→ 約 (\d+) 字/gu)].map((m) => Number(m[1]));
  assert.equal(targets.length, 5);
  assert.equal(
    targets.reduce((a, b) => a + b, 0),
    2625,
  );
});

test('N2: fixed lines are excluded from the per-section suggestions', () => {
  const request = parseEpisodeRequest(requestBody)!;
  const profile = profileFor('podcast-zh-tw-10min')!;
  const lines = fixedLines({ opening_line: OPEN_LINE, closing_line: CLOSE_LINE })!;
  const checked = checkModelOutput(
    request,
    profile,
    withFraming(MODEL_OPENING, MODEL_CLOSING, 3100 - lines.chars),
    lines,
  );
  assert.equal(checked.ok, false);
  if (checked.ok) return;
  const problem = checked.problems.find((p) => p.includes('必須在'))!;
  assert.ok(problem.includes('全部文字合計 3100 字'));
  assert.ok(problem.includes('超出上限 250 字'));
  // the model's own sections scale toward the midpoint minus the fixed chars
  const adjustable = 3100 - lines.chars;
  const scale = (2625 - lines.chars) / adjustable;
  const openingLen = countChars([MODEL_OPENING]);
  assert.ok(problem.includes(`opening 目前 ${openingLen} 字 → 約 ${Math.round(openingLen * scale)} 字`));
});

// --- explicit tenant selection + per-tool Drive folders (agentfleet-team/fisheraiagent#112) ---
// Invented ids only: no real tenant or folder value in tests.

const tenantsSelect = JSON.stringify({
  tenants: [
    {
      id: 'tenant-first',
      caller: { token_env: 'DIGEST_TEST_CALLER_TOKEN' },
      destination: { type: 'google-drive', folder_id: 'folderBase', folders: { voice: 'folderVoiceOnly' } },
    },
    {
      id: 'tenant-second',
      caller: { token_env: 'DIGEST_TEST_CALLER_TOKEN' },
      gemini_key_env: 'DIGEST_TEST_GEMINI_KEY',
      destination: { type: 'google-drive', folder_id: 'folderOther', folders: { digest: 'folderDigest', voice: 'folderVoice' } },
    },
    { id: 'tenant-other', caller: { token_env: 'DIGEST_OTHER_CALLER_TOKEN' } },
  ],
});

const withTenant = (tenant: unknown): unknown => ({ ...(requestBody as object), tenant });

test('T21: the request parser takes an optional tenant slug and rejects a bad one', () => {
  assert.equal(parseEpisodeRequest(requestBody)!.tenant, undefined);
  assert.equal(parseEpisodeRequest(withTenant('tenant-second'))!.tenant, 'tenant-second');
  for (const bad of ['Bad Slug', '-lead', '_lead', 'TRAIL-', 'a'.repeat(65), 7, {}, null]) {
    assert.equal(parseEpisodeRequest(withTenant(bad)), undefined, JSON.stringify(bad));
  }
});

test('T21: a named tenant resolves only itself, not the first authorized match', async () => {
  process.env.DIGEST_TEST_CALLER_TOKEN = 'caller-token-for-test';
  process.env.DIGEST_TEST_GEMINI_KEY = 'tenant-key-for-test';
  try {
    const llm = stubLlm([fixture('model-good.json')]);
    const drive = new StubDrive();
    await withService({ llmFactory: llm.factory, drive, tenantsJson: tenantsSelect }, async (base) => {
      const auth = { authorization: 'Bearer caller-token-for-test', 'x-gemini-key': '' };
      const sent = await post(base, withTenant('tenant-second'), auth);
      assert.equal(sent.status, 202);
      const view = await settle(base, sent.body.job_id);
      assert.equal(view.status, 'done');
      // tenant-second's own destination and folders.digest, not tenant-first's
      assert.deepEqual(view.result.saved, { file_id: 'stub-file-1', name: '2026-11-28-script.md' });
      assert.equal(drive.files[0].folder, 'folderDigest');
      // tenant-second's gemini_key_env, not the caller's (empty) header key
      assert.deepEqual(llm.keys, ['tenant-key-for-test']);
    });
  } finally {
    delete process.env.DIGEST_TEST_CALLER_TOKEN;
    delete process.env.DIGEST_TEST_GEMINI_KEY;
  }
});

test('T21: without the tenant field the first caller-authorized tenant resolves, as today', async () => {
  process.env.DIGEST_TEST_CALLER_TOKEN = 'caller-token-for-test';
  try {
    const llm = stubLlm([fixture('model-good.json')]);
    const drive = new StubDrive();
    await withService({ llmFactory: llm.factory, drive, tenantsJson: tenantsSelect }, async (base) => {
      const auth = { authorization: 'Bearer caller-token-for-test' };
      const sent = await post(base, requestBody, auth);
      assert.equal(sent.status, 202);
      const view = await settle(base, sent.body.job_id);
      assert.equal(view.status, 'done');
      // tenant-first has folders.voice but no folders.digest: digest falls back to folder_id
      assert.equal(drive.files[0].folder, 'folderBase');
    });
  } finally {
    delete process.env.DIGEST_TEST_CALLER_TOKEN;
  }
});

test('T21: a named tenant the bearer does not satisfy, or does not exist, is 403 tenant_forbidden', async () => {
  process.env.DIGEST_TEST_CALLER_TOKEN = 'caller-token-for-test';
  process.env.DIGEST_OTHER_CALLER_TOKEN = 'other-token-for-test';
  try {
    const llm = stubLlm([fixture('model-good.json')]);
    const drive = new StubDrive();
    await withService({ llmFactory: llm.factory, drive, tenantsJson: tenantsSelect }, async (base) => {
      const auth = { authorization: 'Bearer caller-token-for-test' };
      for (const [body, headers] of [
        [withTenant('tenant-other'), auth], // bearer satisfies a different env's token
        [withTenant('no-such-tenant'), auth], // unknown id
        [withTenant('tenant-second'), {}], // no bearer at all
      ] as const) {
        const sent = await post(base, body, headers);
        assert.equal(sent.status, 403, JSON.stringify(body));
        assert.equal(sent.body.error.code, 'tenant_forbidden');
        assert.deepEqual(Object.keys(sent.body.error).sort(), ['code', 'message']);
      }
      assert.equal(llm.calls.length, 0);
      assert.equal(drive.files.length, 0);
    });
  } finally {
    delete process.env.DIGEST_TEST_CALLER_TOKEN;
    delete process.env.DIGEST_OTHER_CALLER_TOKEN;
  }
});

test('T21: the tenants document parses destination.folders and rejects bad values', () => {
  const doc = (destination: unknown) =>
    JSON.stringify({ tenants: [{ id: 'pod', destination }] });
  assert.deepEqual(
    parseTenantsJson(doc({ type: 'google-drive', folder_id: 'base', folders: { digest: 'd1', voice: 'v1' } }), 'test')[0]
      .destination,
    { type: 'google-drive', folder_id: 'base', folders: { digest: 'd1', voice: 'v1' } },
  );
  // a single key keeps the other on the folder_id fallback; unknown keys are ignored
  assert.deepEqual(
    parseTenantsJson(doc({ type: 'google-drive', folder_id: 'base', folders: { digest: 'd1', other: 'x' } }), 'test')[0]
      .destination,
    { type: 'google-drive', folder_id: 'base', folders: { digest: 'd1' } },
  );
  const bad: unknown[] = [
    { type: 'google-drive', folder_id: 'base', folders: 'd1' },
    { type: 'google-drive', folder_id: 'base', folders: { digest: '' } },
    { type: 'google-drive', folder_id: 'base', folders: { digest: '   ' } },
    { type: 'google-drive', folder_id: 'base', folders: { digest: 'bad id!' } },
    { type: 'google-drive', folder_id: 'base', folders: { voice: 3 } },
  ];
  for (const destination of bad) {
    assert.throws(
      () => parseTenantsJson(doc(destination), 'test'),
      (err: unknown) => err instanceof TranscriptError && err.code === 'invalid_config',
      JSON.stringify(destination),
    );
  }
});

test('T21 file_prefix: the tenants document parses destination.file_prefix and rejects bad values', () => {
  const doc = (destination: unknown) =>
    JSON.stringify({ tenants: [{ id: 'pod', destination }] });
  assert.deepEqual(
    parseTenantsJson(doc({ type: 'google-drive', folder_id: 'base', file_prefix: 'trial-' }), 'test')[0]
      .destination,
    { type: 'google-drive', folder_id: 'base', file_prefix: 'trial-' },
  );
  const bad: unknown[] = [
    { type: 'google-drive', folder_id: 'base', file_prefix: 7 },
    { type: 'google-drive', folder_id: 'base', file_prefix: '' },
    { type: 'google-drive', folder_id: 'base', file_prefix: '   ' },
    { type: 'google-drive', folder_id: 'base', file_prefix: 'x'.repeat(1024) },
    { type: 'google-drive', folder_id: 'base', file_prefix: 'a/b' },
    { type: 'google-drive', folder_id: 'base', file_prefix: 'a\\b' },
  ];
  for (const destination of bad) {
    assert.throws(
      () => parseTenantsJson(doc(destination), 'test'),
      (err: unknown) => err instanceof TranscriptError && err.code === 'invalid_config',
      JSON.stringify(destination),
    );
  }
});

// Three tenants over one folder: two carry distinct file_prefix values and
// one carries none, so all three of a date's names coexist without collision.
const tenantsPrefix = JSON.stringify({
  tenants: [
    {
      id: 'pre-a',
      caller: { token_env: 'DIGEST_TEST_CALLER_TOKEN' },
      destination: { type: 'google-drive', folder_id: 'sharedFolder', file_prefix: 'aa-' },
    },
    {
      id: 'pre-b',
      caller: { token_env: 'DIGEST_TEST_CALLER_TOKEN' },
      destination: { type: 'google-drive', folder_id: 'sharedFolder', file_prefix: 'bb-' },
    },
    {
      id: 'pre-legacy',
      caller: { token_env: 'DIGEST_TEST_CALLER_TOKEN' },
      destination: { type: 'google-drive', folder_id: 'sharedFolder' },
    },
  ],
});

test('T21 file_prefix: distinct prefixes and omission share one folder on the same date; a retry hits the prefixed name', async () => {
  process.env.DIGEST_TEST_CALLER_TOKEN = 'caller-token-for-test';
  try {
    // The fourth LLM call returns a different script, so the retry would
    // store different bytes if the no-overwrite lookup missed.
    const variant = JSON.parse(fixture('model-good.json')) as { sections: { text: string }[] };
    variant.sections[0].text = `改${variant.sections[0].text.slice(1)}`;
    const llm = stubLlm([
      fixture('model-good.json'),
      fixture('model-good.json'),
      fixture('model-good.json'),
      JSON.stringify(variant),
    ]);
    const drive = new StubDrive();
    await withService({ llmFactory: llm.factory, drive, tenantsJson: tenantsPrefix }, async (base) => {
      const auth = { authorization: 'Bearer caller-token-for-test' };
      const saved = new Map<string, { file_id: string; name: string }>();
      for (const [tenant, name] of [
        ['pre-a', 'aa-2026-11-28-script.md'],
        ['pre-b', 'bb-2026-11-28-script.md'],
        ['pre-legacy', '2026-11-28-script.md'],
      ] as const) {
        const sent = await post(base, withTenant(tenant), auth);
        assert.equal(sent.status, 202);
        const view = await settle(base, sent.body.job_id);
        assert.equal(view.status, 'done', tenant);
        assert.equal(view.result.saved.name, name);
        saved.set(tenant, view.result.saved as { file_id: string; name: string });
      }
      assert.deepEqual(
        drive.files.map((f) => [f.folder, f.name]),
        [
          ['sharedFolder', 'aa-2026-11-28-script.md'],
          ['sharedFolder', 'bb-2026-11-28-script.md'],
          ['sharedFolder', '2026-11-28-script.md'],
        ],
      );
      // Retry pre-a with changed request content: the prefixed name is the
      // lookup key, so the same id and the original bytes stand and nothing
      // new is written.
      const changed = JSON.parse(JSON.stringify(requestBody)) as { sources: { title: string }[] };
      changed.sources[0].title = 'a changed source title';
      const sent = await post(base, { ...changed, tenant: 'pre-a' }, auth);
      assert.equal(sent.status, 202);
      const view = await settle(base, sent.body.job_id);
      assert.equal(view.status, 'done');
      assert.deepEqual(view.result.saved, saved.get('pre-a'));
      assert.notEqual(view.result.markdown, drive.files[0].content);
      assert.equal(drive.files.length, 3);
    });
  } finally {
    delete process.env.DIGEST_TEST_CALLER_TOKEN;
  }
});
