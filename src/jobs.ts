import { randomUUID } from 'node:crypto';
import { codeOf, messageForCode } from './errors.js';
import type { GeminiCaller } from './gemini.js';
import type { SafeText } from './safe-text.js';
import { transcribeYouTube } from './transcribe.js';
import type { Transcript } from './transcript.js';

export type JobStatus = 'queued' | 'running' | 'done' | 'failed';

// The failed-job HTTP body carries the same branded message as ErrorBody:
// only a fixed table entry, never caught text.
export interface JobError {
  code: string;
  message: SafeText;
}

export interface JobView {
  job_id: string;
  status: JobStatus;
  result?: Transcript;
  error?: JobError;
}

export interface JobRunnerDeps {
  callerFactory: (apiKey: string) => GeminiCaller;
  model: string;
  maxBlockSeconds: number;
  cacheDir: string;
  log?: (line: string) => void; // sink for allowlisted log lines
}

const MAX_JOBS = 1000;

interface JobRecord {
  status: JobStatus;
  result?: Transcript;
  error?: JobError;
}

// In-process job store. The caller's API key is never part of a record: it
// lives only inside the run closure (and the Gemini client it builds) for the
// duration of that one job. A restart loses every job.
export class JobStore {
  private readonly records = new Map<string, JobRecord>();

  constructor(private readonly deps: JobRunnerDeps) {}

  submit(videoId: string, apiKey: string): string {
    const id = randomUUID();
    this.records.set(id, { status: 'queued' });
    this.prune();
    setImmediate(() => void this.run(id, videoId, apiKey));
    return id;
  }

  get(id: string): JobView | undefined {
    const record = this.records.get(id);
    if (!record) return undefined;
    const view: JobView = { job_id: id, status: record.status };
    if (record.result !== undefined) view.result = record.result;
    if (record.error !== undefined) view.error = record.error;
    return view;
  }

  private async run(id: string, videoId: string, apiKey: string): Promise<void> {
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
      record.status = 'done';
    } catch (err) {
      record.status = 'failed';
      const code = codeOf(err);
      record.error = { code, message: messageForCode(code) };
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
