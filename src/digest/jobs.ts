import { randomUUID } from 'node:crypto';
import type { Tenant } from '../tenants.js';
import { checkModelOutput } from './check.js';
import { requestHash, type EpisodeRequest, type EpisodeScript } from './contract.js';
import { DigestError, digestCodeOf, errorView, type DigestErrorView } from './errors.js';
import type { DigestLlm } from './llm.js';
import { buildDraftPrompt, buildRepairPrompt, profileFor, type Profile } from './profile.js';
import { saveScript, type DigestDrive } from './save.js';

export type DigestJobStatus = 'queued' | 'running' | 'done' | 'failed';

export interface DigestJobView {
  job_id: string;
  status: DigestJobStatus;
  result?: EpisodeScript;
  error?: DigestErrorView;
  save_error?: DigestErrorView;
}

export interface DigestJobDeps {
  llmFactory: (apiKey: string) => DigestLlm;
  drive?: DigestDrive;
}

const MAX_JOBS = 1000;

interface JobRecord {
  status: DigestJobStatus;
  result?: EpisodeScript;
  error?: DigestErrorView;
  save_error?: DigestErrorView;
}

export type SubmitOutcome =
  | { kind: 'accepted'; jobId: string }
  | { kind: 'replayed'; jobId: string }
  | { kind: 'conflict' }
  | { kind: 'missing_key' };

// In-process job store, like the transcript tool's. The caller's API key
// lives only in the run closure and the LLM client it builds. A restart
// loses every job and every Idempotency-Key.
export class DigestJobStore {
  private readonly records = new Map<string, JobRecord>();
  private readonly keys = new Map<string, { hash: string; jobId: string }>();

  constructor(private readonly deps: DigestJobDeps) {}

  // `scope` names the verified caller, so one caller's Idempotency-Key never
  // matches another's. The same key with the same request returns the first
  // job and starts nothing; the same key with another request is a conflict.
  submit(
    request: EpisodeRequest,
    apiKey: string,
    tenant: Tenant | undefined,
    idempotency?: { scope: string; key: string },
  ): SubmitOutcome {
    const hash = requestHash(request);
    const mapKey = idempotency === undefined ? undefined : `${idempotency.scope}\n${idempotency.key}`;
    if (mapKey !== undefined) {
      const seen = this.keys.get(mapKey);
      if (seen !== undefined) {
        return seen.hash === hash ? { kind: 'replayed', jobId: seen.jobId } : { kind: 'conflict' };
      }
    }
    if (apiKey === '') return { kind: 'missing_key' };
    const id = randomUUID();
    this.records.set(id, { status: 'queued' });
    if (mapKey !== undefined) this.keys.set(mapKey, { hash, jobId: id });
    this.prune();
    setImmediate(() => void this.run(id, request, apiKey, tenant));
    return { kind: 'accepted', jobId: id };
  }

  get(id: string): DigestJobView | undefined {
    const record = this.records.get(id);
    if (!record) return undefined;
    const view: DigestJobView = { job_id: id, status: record.status };
    if (record.result !== undefined) view.result = record.result;
    if (record.error !== undefined) view.error = record.error;
    if (record.save_error !== undefined) view.save_error = record.save_error;
    return view;
  }

  private async run(id: string, request: EpisodeRequest, apiKey: string, tenant: Tenant | undefined): Promise<void> {
    const record = this.records.get(id);
    if (!record) return;
    record.status = 'running';
    try {
      const profile = profileFor(request.profile);
      if (profile === undefined) throw new DigestError('invalid_request');
      const script = await draftAndCheck(this.deps.llmFactory(apiKey), profile, request);
      try {
        const saved = await saveScript(this.deps.drive, tenant, request.date, script.markdown);
        if (saved !== undefined) script.saved = saved;
      } catch {
        record.save_error = errorView('save_failed');
      }
      record.result = script;
      record.status = 'done';
    } catch (err) {
      record.error = errorView(digestCodeOf(err));
      record.status = 'failed';
    }
  }

  private prune(): void {
    if (this.records.size <= MAX_JOBS) return;
    for (const [id, record] of this.records) {
      if (record.status === 'done' || record.status === 'failed') {
        this.records.delete(id);
        for (const [k, v] of this.keys) if (v.jobId === id) this.keys.delete(k);
        if (this.records.size <= MAX_JOBS) return;
      }
    }
  }
}

// The draft and check nodes: one model call, and at most one repair call
// when the output fails the check. A second failure ends the job.
async function draftAndCheck(llm: DigestLlm, profile: Profile, request: EpisodeRequest): Promise<EpisodeScript> {
  const draft = await llm({ system: profile.system, prompt: buildDraftPrompt(profile, request) });
  const first = checkModelOutput(request, profile, draft);
  if (first.ok) return first.script;
  const repaired = await llm({
    system: profile.system,
    prompt: buildRepairPrompt(profile, request, draft, first.problems),
  });
  const second = checkModelOutput(request, profile, repaired);
  if (second.ok) return second.script;
  throw new DigestError('script_check_failed');
}
