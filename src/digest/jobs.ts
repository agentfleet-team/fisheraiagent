import { randomUUID } from 'node:crypto';
import type { Tenant } from '../tenants.js';
import { checkModelOutput, fixedLines, type FixedLines } from './check.js';
import { fitModelOutput } from './fit.js';
import { requestHash, type EpisodeRequest, type EpisodeScript } from './contract.js';
import { DigestError, digestCodeOf, errorView, type DigestErrorView } from './errors.js';
import type { DigestLlm } from './llm.js';
import { buildDraftPrompt, buildRepairPrompt, profileFor, type Profile } from './profile.js';
import { saveScript, type DigestDrive } from './save.js';
import { consoleSink, type LogSink } from '../log.js';

export type DigestJobStatus = 'queued' | 'running' | 'done' | 'failed';

export interface DigestJobView {
  job_id: string;
  status: DigestJobStatus;
  result?: EpisodeScript;
  error?: DigestJobError;
  save_error?: DigestErrorView;
}

// A failed job's error. `problems` is set only on `script_check_failed`: the
// problem strings of the last failed check. The check writes them from fixed
// templates and counts; they hold no transcript text.
export interface DigestJobError extends DigestErrorView {
  problems?: string[];
}

export interface DigestJobDeps {
  llmFactory: (apiKey: string) => DigestLlm;
  drive?: DigestDrive;
  // Receives one line per failed check. Defaults to the console.
  logSink?: LogSink;
}

// The draft call, then up to this many repair calls.
export const MAX_REPAIR_CALLS = 2;
const MAX_LOGGED_PROBLEM_CHARS = 300;

class ScriptCheckFailed extends DigestError {
  constructor(readonly problems: string[]) {
    super('script_check_failed');
  }
}

const MAX_JOBS = 1000;

interface JobRecord {
  status: DigestJobStatus;
  result?: EpisodeScript;
  error?: DigestJobError;
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
      const script = await draftAndCheck(
        this.deps.llmFactory(apiKey),
        profile,
        request,
        fixedLines(tenant?.digest),
        (attempt, problems) => this.logFailedCheck(id, attempt, problems),
        (line) => (this.deps.logSink ?? consoleSink)(`job=${id} ${line}`),
      );
      try {
        const saved = await saveScript(this.deps.drive, tenant, request.date, script.markdown);
        if (saved !== undefined) script.saved = saved;
      } catch {
        record.save_error = errorView('save_failed');
      }
      record.result = script;
      record.status = 'done';
    } catch (err) {
      record.error = jobError(err);
      record.status = 'failed';
    }
  }

  // One line per failed check: the job id, the attempt number (1 is the
  // draft) and the problem strings as one JSON array. The strings are cut and
  // JSON-escaped, so they cannot break the line or carry control characters.
  private logFailedCheck(id: string, attempt: number, problems: string[]): void {
    const shown = JSON.stringify(problems.map((p) => p.slice(0, MAX_LOGGED_PROBLEM_CHARS)));
    (this.deps.logSink ?? consoleSink)(`digest_check_failed job=${id} attempt=${attempt} problems=${shown}`);
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

function jobError(err: unknown): DigestJobError {
  const view = errorView(digestCodeOf(err));
  if (!(err instanceof ScriptCheckFailed)) return view;
  return {
    ...view,
    message: `the model output failed the script check after ${MAX_REPAIR_CALLS} repair calls`,
    problems: err.problems,
  };
}

// The draft and check nodes: one model call, then up to MAX_REPAIR_CALLS
// repair calls. Each repair prompt names the problems of the check before it.
// After the last repair call the fit step drops whole sentences when the
// draft is still overlong. A passing check ends the loop; the last failed
// check ends the job.
async function draftAndCheck(
  llm: DigestLlm,
  profile: Profile,
  request: EpisodeRequest,
  lines: FixedLines | undefined,
  onFailedCheck: (attempt: number, problems: string[]) => void,
  onFit: (line: string) => void,
): Promise<EpisodeScript> {
  let output = await llm({ system: profile.system, prompt: buildDraftPrompt(profile, request, lines) });
  for (let attempt = 1; ; attempt += 1) {
    if (attempt === MAX_REPAIR_CALLS + 1) {
      const { min, max } = profile.lengthBand;
      const fitted = fitModelOutput(output, lines?.chars ?? 0, min, max);
      if (fitted !== undefined) {
        output = fitted.raw;
        onFit(`fit removed=${fitted.removed} chars_before=${fitted.charsBefore} chars_after=${fitted.charsAfter}`);
      }
    }
    const checked = checkModelOutput(request, profile, output, lines);
    if (checked.ok) return checked.script;
    onFailedCheck(attempt, checked.problems);
    if (attempt > MAX_REPAIR_CALLS) throw new ScriptCheckFailed(checked.problems);
    output = await llm({
      system: profile.system,
      prompt: buildRepairPrompt(profile, request, output, checked.problems, lines),
    });
  }
}
