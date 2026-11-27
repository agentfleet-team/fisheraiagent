import type { SubmitResult, TranscriptDoc } from "./tool1.js";

/**
 * Request and result shapes of tool 2 (digest) and tool 3 (voice), copied
 * from `src/digest/openapi.yaml` and `src/voice/openapi.yaml` in
 * agentfleet-team/fisheraiagent.
 */
export interface EpisodeSource {
  slot: number;
  title: string;
  channel: string;
  url: string;
  published?: string;
  transcript: TranscriptDoc;
}

export interface EpisodeRequest {
  profile: "podcast-zh-tw-10min";
  date: string;
  sources: EpisodeSource[];
  missing_slots: number[];
}

export interface ScriptSection {
  id: string;
  kind: "opening" | "segment" | "closing";
  slot?: number;
  video_id?: string;
  text: string;
  refs?: { video_id: string; start: number }[];
}

export interface EpisodeScript {
  profile: string;
  title: string;
  sections: ScriptSection[];
  char_count: number;
  markdown: string;
  saved?: { file_id: string; name: string };
}

export interface VoiceRequest {
  date: string;
  voice: { engine: "edge"; name: string; rate: string };
  sections: { id: string; text: string }[];
  expect_seconds: { min: number; max: number };
}

export interface VoiceMark {
  section_id: string;
  index: number;
  start_ms: number;
  end_ms: number;
  text: string;
}

export interface VoiceResult {
  duration_s: number;
  bytes: number;
  sha256: string;
  format: string;
  marks: VoiceMark[];
  saved?: { audio_file_id: string; marks_file_id: string; names: string[] };
}

export type JobPoll<R> =
  | { kind: "queued" | "running" }
  | { kind: "done"; result: R }
  | { kind: "failed"; error: string }
  | { kind: "not_found" }
  | { kind: "retry" }
  | { kind: "fatal"; error: string };

/**
 * The tool 2 / tool 3 job API: `POST /v1/jobs` with an `Idempotency-Key`,
 * then `GET /v1/jobs/<id>`. The same key with the same request returns the
 * first job, so a resubmit after a crash never makes a second job.
 */
export interface JobTool<Req, Res> {
  submit(body: Req, idempotencyKey: string): Promise<SubmitResult>;
  poll(jobId: string): Promise<JobPoll<Res>>;
}

function errorCode(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const error = (payload as Record<string, unknown>).error;
  if (typeof error !== "object" || error === null) return null;
  const code = (error as Record<string, unknown>).code;
  return typeof code === "string" ? code : null;
}

async function readJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

export function httpJobTool<Req, Res>(
  baseUrl: string,
  token: string | undefined,
): JobTool<Req, Res> {
  const base = baseUrl.replace(/\/+$/, "");
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Agent": "podcast-night",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
  return {
    async submit(body: Req, idempotencyKey: string): Promise<SubmitResult> {
      let res: Response;
      try {
        res = await fetch(`${base}/v1/jobs`, {
          method: "POST",
          headers: { ...headers, "Idempotency-Key": idempotencyKey },
          body: JSON.stringify(body),
        });
      } catch {
        return { kind: "retry" };
      }
      const payload = await readJson(res);
      if (res.status === 202 || res.status === 200) {
        const jobId =
          typeof payload === "object" && payload !== null
            ? (payload as Record<string, unknown>).job_id
            : null;
        return typeof jobId === "string"
          ? { kind: "job", jobId }
          : { kind: "fatal", error: "no_job_id" };
      }
      if (res.status === 429 || res.status >= 500) return { kind: "retry" };
      return { kind: "fatal", error: errorCode(payload) ?? `http_${res.status}` };
    },

    async poll(jobId: string): Promise<JobPoll<Res>> {
      let res: Response;
      try {
        res = await fetch(`${base}/v1/jobs/${encodeURIComponent(jobId)}`, {
          method: "GET",
          headers,
        });
      } catch {
        return { kind: "retry" };
      }
      const payload = await readJson(res);
      if (res.status === 404) return { kind: "not_found" };
      if (!res.ok) {
        if (res.status === 429 || res.status >= 500) return { kind: "retry" };
        return { kind: "fatal", error: errorCode(payload) ?? `http_${res.status}` };
      }
      const view = payload as {
        status?: string;
        result?: Res;
        error?: { code?: string };
      } | null;
      if (view?.status === "queued" || view?.status === "running") {
        return { kind: view.status };
      }
      if (view?.status === "done" && view.result !== undefined) {
        return { kind: "done", result: view.result };
      }
      if (view?.status === "failed") {
        return {
          kind: "failed",
          error: typeof view.error?.code === "string" ? view.error.code : "job_failed",
        };
      }
      return { kind: "fatal", error: "bad_job_view" };
    },
  };
}
