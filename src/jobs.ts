import { randomUUID } from 'node:crypto';
import { codeOf, messageForCode, TranscriptError, type FixedErrorCode } from './errors.js';
import type { GeminiCaller } from './gemini.js';
import { SaveFailedError, type SavedFile } from './save.js';
import type { SafeText } from './safe-text.js';
import type { JobOrigin, TenantLimits } from './tenants.js';
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
  windowSeconds?: number;
  log?: (line: string) => void; // sink for allowlisted log lines
  // After a transcript exists, persist it wherever the job's origin resolved
  // to. The origin here is a caller claim the HTTP boundary already
  // authenticated. Returns the saved file, undefined when nothing should be
  // saved, and throws on failure — the transcript is still returned either
  // way.
  saveTranscript?: (origin: JobOrigin, transcript: Transcript) => Promise<SavedFile | undefined>;
  // A length known before any Gemini call (local metadata such as the
  // transcript cache); used by the per-tenant max_video_seconds limit to
  // reject an over-length video without spending a call.
  knownDurationSeconds?: (videoId: string) => Promise<number | undefined>;
}

// Why a job's transcript must not be saved even though it completed:
// 'unauthorized' — the origin claim resolved to a tenant but failed the
// caller-credential check; 'no_tenant' — a verified sign-in session whose
// email no tenant's web_emails allowlists. Either way the job still runs
// and returns the transcript; the fixed message reports it.
export type SaveBlock = 'unauthorized' | 'no_tenant';

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

  // `saveBlocked` marks a job whose transcript must not be saved (see
  // SaveBlock): the job still runs and returns the transcript, and the
  // matching fixed error is what the origin sees. `limits` is the resolved
  // tenant's limits, applied only to the job it came with.
  submit(
    videoId: string,
    apiKey: string,
    origin?: JobOrigin,
    saveBlocked?: SaveBlock,
    limits?: TenantLimits,
  ): string {
    const id = randomUUID();
    this.records.set(id, { status: 'queued' });
    this.prune();
    setImmediate(() => void this.run(id, videoId, apiKey, origin, saveBlocked, limits));
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
    saveBlocked?: SaveBlock,
    limits?: TenantLimits,
  ): Promise<void> {
    const record = this.records.get(id);
    if (!record) return;
    record.status = 'running';
    try {
      if (limits?.max_video_seconds !== undefined && this.deps.knownDurationSeconds) {
        const known = await this.deps.knownDurationSeconds(videoId);
        if (known !== undefined && known > limits.max_video_seconds) {
          throw new TranscriptError('video_too_long', 'video exceeds the tenant length limit');
        }
      }
      record.result = await transcribeYouTube(videoId, {
        caller: this.deps.callerFactory(apiKey),
        model: this.deps.model,
        maxBlockSeconds: this.deps.maxBlockSeconds,
        cacheDir: this.deps.cacheDir,
        windowSeconds: this.deps.windowSeconds,
        log: this.deps.log,
        maxVideoSeconds: limits?.max_video_seconds,
      });
      if (this.deps.saveTranscript && origin) {
        try {
          const saved = await this.deps.saveTranscript(origin, record.result);
          if (saved) record.saved = saved;
        } catch (err) {
          record.save_error = toJobError(err);
        }
      } else if (saveBlocked !== undefined) {
        const code = saveBlocked === 'unauthorized' ? 'save_unauthorized' : 'no_tenant';
        record.save_error = { code, message: messageForCode(code) };
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
