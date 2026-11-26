import { randomUUID } from 'node:crypto';
import type { Tenant } from '../tenants.js';
import { requestHash, type VoiceRequest, type VoiceResult } from './contract.js';
import type { VoiceEngine } from './engine.js';
import { errorView, voiceErrorView, type VoiceErrorView } from './errors.js';
import { renderEpisode } from './render.js';
import { saveEpisode, type VoiceDrive } from './save.js';

export type VoiceJobStatus = 'queued' | 'running' | 'done' | 'failed';

export interface VoiceJobView {
  job_id: string;
  status: VoiceJobStatus;
  result?: VoiceResult;
  error?: VoiceErrorView;
  save_error?: VoiceErrorView;
}

export interface VoiceJobDeps {
  engine: VoiceEngine;
  drive?: VoiceDrive;
  chunkTimeoutMs?: number;
}

const MAX_JOBS = 1000;
// Finished MP3 files stay in memory for the newest jobs only.
const MAX_AUDIO_JOBS = 4;

interface JobRecord {
  status: VoiceJobStatus;
  result?: VoiceResult;
  error?: VoiceErrorView;
  save_error?: VoiceErrorView;
  audio?: Buffer;
}

export type SubmitOutcome =
  | { kind: 'accepted'; jobId: string }
  | { kind: 'replayed'; jobId: string }
  | { kind: 'conflict' };

// In-process job store, like the digest tool's. A restart loses every job and
// every Idempotency-Key.
export class VoiceJobStore {
  private readonly records = new Map<string, JobRecord>();
  private readonly keys = new Map<string, { hash: string; jobId: string }>();

  constructor(private readonly deps: VoiceJobDeps) {}

  // `scope` names the verified caller. The same key with the same request
  // returns the first job and renders nothing; with another request it is a conflict.
  submit(
    request: VoiceRequest,
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
    const id = randomUUID();
    this.records.set(id, { status: 'queued' });
    if (mapKey !== undefined) this.keys.set(mapKey, { hash, jobId: id });
    this.prune();
    setImmediate(() => void this.run(id, request, tenant));
    return { kind: 'accepted', jobId: id };
  }

  get(id: string): VoiceJobView | undefined {
    const record = this.records.get(id);
    if (!record) return undefined;
    const view: VoiceJobView = { job_id: id, status: record.status };
    if (record.result !== undefined) view.result = record.result;
    if (record.error !== undefined) view.error = record.error;
    if (record.save_error !== undefined) view.save_error = record.save_error;
    return view;
  }

  audio(id: string): Buffer | undefined {
    return this.records.get(id)?.audio;
  }

  private async run(id: string, request: VoiceRequest, tenant: Tenant | undefined): Promise<void> {
    const record = this.records.get(id);
    if (!record) return;
    record.status = 'running';
    try {
      const episode = await renderEpisode(request, {
        engine: this.deps.engine,
        chunkTimeoutMs: this.deps.chunkTimeoutMs,
      });
      try {
        const saved = await saveEpisode(
          this.deps.drive,
          tenant,
          request.date,
          episode.audio,
          episode.result.marks,
          episode.result.duration_s,
        );
        if (saved !== undefined) episode.result.saved = saved;
      } catch {
        record.save_error = errorView('save_failed');
      }
      record.result = episode.result;
      record.audio = episode.audio;
      record.status = 'done';
      this.dropOldAudio();
    } catch (err) {
      record.error = voiceErrorView(err);
      record.status = 'failed';
    }
  }

  private dropOldAudio(): void {
    const withAudio = [...this.records.values()].filter((r) => r.audio !== undefined);
    for (const record of withAudio.slice(0, Math.max(0, withAudio.length - MAX_AUDIO_JOBS))) {
      delete record.audio;
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
