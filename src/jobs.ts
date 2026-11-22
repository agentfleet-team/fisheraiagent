import { randomUUID } from 'node:crypto';
import { codeOf, messageForCode, TranscriptError, type FixedErrorCode } from './errors.js';
import type { GeminiCaller } from './gemini.js';
import { SaveFailedError, type SavedFile } from './save.js';
import type { SafeText } from './safe-text.js';
import type { JobOrigin } from './tenants.js';
import { transcribeYouTube } from './transcribe.js';
import type { Transcript } from './transcript.js';

export type JobStatus = 'queued' | 'running' | 'done' | 'failed';

// The failed-job HTTP body carries the same branded message as ErrorBody:
// only a fixed table entry, never caught text. `status` is a numeric
// diagnostic — the upstream HTTP status when the failure came from a
// remote service (for example a Drive 403), never free text.
export interface JobError {
  code: FixedErrorCode;
  message: SafeText;
  status?: number;
}

export interface JobView {
  job_id: string;
  status: JobStatus;
  result?: Transcript;
  error?: JobError;
  saved?: SavedFile;
  save_error?: JobError;
}

export interface JobRunnerDeps {
  callerFactory: (apiKey: string) => GeminiCaller;
  model: string;
  maxBlockSeconds: number;
  cacheDir: string;
  log?: (line: string) => void; // sink for allowlisted log lines
  // After a transcript exists, persist it wherever the job's origin resolved
  // to. The origin here is a caller claim the HTTP boundary already
  // authenticated. Returns the saved file, undefined when nothing should be
  // saved, and throws on failure — the transcript is still returned either
  // way.
  saveTranscript?: (origin: JobOrigin, transcript: Transcript) => Promise<SavedFile | undefined>;
}

const MAX_JOBS = 1000;

interface JobRecord {
  status: JobStatus;
  result?: Transcript;
  error?: JobError;
  saved?: SavedFile;
  save_error?: JobError;
}

// In-process job store. The caller's API key is never part of a record: it
// lives only inside the run closure (and the Gemini client it builds) for the
// duration of that one job. A restart loses every job.
export class JobStore {
  private readonly records = new Map<string, JobRecord>();

  constructor(private readonly deps: JobRunnerDeps) {}

  // `saveDenied` marks a claim that resolved to a tenant but failed the
  // tenant's caller-credential check: the job still runs and returns the
  // transcript, and the fixed save_unauthorized error is what the origin
  // sees.
  submit(videoId: string, apiKey: string, origin?: JobOrigin, saveDenied = false): string {
    const id = randomUUID();
    this.records.set(id, { status: 'queued' });
    this.prune();
    setImmediate(() => void this.run(id, videoId, apiKey, origin, saveDenied));
    return id;
  }

  get(id: string): JobView | undefined {
    const record = this.records.get(id);
    if (!record) return undefined;
    const view: JobView = { job_id: id, status: record.status };
    if (record.result !== undefined) view.result = record.result;
    if (record.error !== undefined) view.error = record.error;
    if (record.saved !== undefined) view.saved = record.saved;
    if (record.save_error !== undefined) view.save_error = record.save_error;
    return view;
  }

  private async run(
    id: string,
    videoId: string,
    apiKey: string,
    origin?: JobOrigin,
    saveDenied = false,
  ): Promise<void> {
    const record = this.records.get(id);
    if (!record) return;
    record.status = 'running';
    try {
      record.result = await transcribeYouTube(videoId, {
        caller: this.deps.callerFactory(apiKey),
        model: this.deps.model,
        maxBlockSeconds: this.deps.maxBlockSeconds,
        cacheDir: this.deps.cacheDir,
        log: this.deps.log,
      });
      if (this.deps.saveTranscript && origin) {
        try {
          const saved = await this.deps.saveTranscript(origin, record.result);
          if (saved) record.saved = saved;
        } catch (err) {
          record.save_error = toJobError(err);
        }
      } else if (saveDenied) {
        record.save_error = { code: 'save_unauthorized', message: messageForCode('save_unauthorized') };
      }
      record.status = 'done';
    } catch (err) {
      record.status = 'failed';
      record.error = toJobError(err);
    }
  }

  private prune(): void {
    if (this.records.size <= MAX_JOBS) return;
    for (const [id, record] of this.records) {
      if (record.status === 'done' || record.status === 'failed') {
        this.records.delete(id);
        if (this.records.size <= MAX_JOBS) return;
      }
    }
  }
}

// A job error view is a fixed code, its branded table message and an
// optional numeric status — never caught text, so the caller's API key and
// upstream error strings cannot reach the wire through this path.
function toJobError(err: unknown): JobError {
  const code = err instanceof SaveFailedError ? err.code : codeOf(err);
  const view: JobError = { code, message: messageForCode(code) };
  const status =
    err instanceof SaveFailedError
      ? err.status
      : err instanceof TranscriptError
        ? err.httpStatus
        : undefined;
  if (status !== undefined) view.status = status;
  return view;
}
