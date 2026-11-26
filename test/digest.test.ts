import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';
import { checkModelOutput } from '../src/digest/check.js';
import { parseEpisodeRequest } from '../src/digest/contract.js';
import { createDigestService } from '../src/digest/service.js';
import type { DigestLlm, DigestLlmRequest } from '../src/digest/llm.js';
import { profileFor } from '../src/digest/profile.js';
import type { DigestDrive } from '../src/digest/save.js';

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

test('D3: an output outside the length band triggers one repair call; a second failure ends failed with script_check_failed', async () => {
  const llm = stubLlm([fixture('model-short.json'), fixture('model-short.json')]);
  await withService({ llmFactory: llm.factory }, async (base) => {
    const sent = await post(base, requestBody);
    const view = await settle(base, sent.body.job_id);
    assert.equal(view.status, 'failed');
    assert.equal(view.error.code, 'script_check_failed');
    assert.equal(view.result, undefined);
    assert.equal(llm.calls.length, 2);
  });
});

test('D3: the band fixtures at 2,400 and 2,800 characters each trigger the one repair call; the 2,600 fixture passes check', async () => {
  const request = parseEpisodeRequest(requestBody)!;
  const profile = profileFor('podcast-zh-tw-10min')!;
  const at2600 = checkModelOutput(request, profile, fixture('model-good.json'));
  assert.ok(at2600.ok);
  assert.equal(at2600.script.char_count, 2600);
  for (const bad of ['model-band-low.json', 'model-band-high.json']) {
    const llm = stubLlm([fixture(bad), fixture('model-good.json')]);
    await withService({ llmFactory: llm.factory }, async (base) => {
      const sent = await post(base, requestBody);
      const view = await settle(base, sent.body.job_id);
      assert.equal(view.status, 'done');
      assert.equal(llm.calls.length, 2);
      assert.ok(llm.calls[1].prompt.includes('必須在 2500 到 2700 字之間'));
    });
  }
});

test('D3: output that is not JSON counts as a failed check and gets one repair call', async () => {
  const llm = stubLlm(['not json at all', fixture('model-no-ref.json')]);
  await withService({ llmFactory: llm.factory }, async (base) => {
    const sent = await post(base, requestBody);
    const view = await settle(base, sent.body.job_id);
    assert.equal(view.status, 'failed');
    assert.equal(view.error.code, 'script_check_failed');
    assert.equal(llm.calls.length, 2);
  });
});

test('D3: a ref that points outside the transcript fails the check', () => {
  const request = parseEpisodeRequest(requestBody)!;
  const out = JSON.parse(fixture('model-good.json'));
  out.sections[1].refs = [{ video_id: 'aaaaaaaaaaa', start: 99999 }];
  const result = checkModelOutput(request, profileFor('podcast-zh-tw-10min')!, JSON.stringify(out));
  assert.equal(result.ok, false);
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
      id: 'akina',
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
