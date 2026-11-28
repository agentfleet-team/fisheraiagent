export interface TranscriptBlock {
  start: number;
  end: number;
  text: string;
}

export type TranscriptSource = "captions:manual" | "captions:auto" | "gemini";

/** Tool 1 `Transcript` (transcripts.agentfleet.team openapi.yaml). */
export interface TranscriptDoc {
  video_id: string;
  source_url?: string;
  language?: string;
  source?: TranscriptSource;
  blocks: TranscriptBlock[];
}

export type SubmitResult =
  | { kind: "job"; jobId: string }
  | { kind: "retry" } // transient: rate limit, 5xx, transport — same attempt next tick
  | { kind: "fatal"; error: string };

export type PollResult =
  | { kind: "queued" | "running" }
  | { kind: "done"; result: TranscriptDoc }
  | { kind: "failed"; error: string }
  | { kind: "not_found" }
  | { kind: "retry" }
  | { kind: "fatal"; error: string };

/**
 * The tool 1 job API: `POST /v1/jobs {url}` then `GET /v1/jobs/<id>`.
 * Tool 1 has no Idempotency-Key header: it dedupes by its per-video-id
 * transcript cache, so a resubmit of the same url is a cache hit once any
 * job for that video finished. Jobs are in memory, so a `not_found` poll
 * means the tool restarted and the job is submitted again.
 */
export interface Tool1 {
  /** `tenant` is the id the tool resolves to the tenant key its caller token unlocks. */
  submit(url: string, tenant?: string): Promise<SubmitResult>;
  poll(jobId: string): Promise<PollResult>;
}

function bodyErrorCode(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const error = (payload as Record<string, unknown>).error;
  if (typeof error !== "object" || error === null) return null;
  const code = (error as Record<string, unknown>).code;
  return typeof code === "string" ? code : null;
}

export function httpTool1(baseUrl: string, token: string | undefined): Tool1 {
  const base = baseUrl.replace(/\/+$/, "");
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Agent": "podcast-night",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };

  function classify(res: Response, payload: unknown): SubmitResult {
    if (res.status === 429 || res.status >= 500) return { kind: "retry" };
    return { kind: "fatal", error: bodyErrorCode(payload) ?? `http_${res.status}` };
  }

  return {
    async submit(url: string, tenant?: string): Promise<SubmitResult> {
      let res: Response;
      try {
        res = await fetch(`${base}/v1/jobs`, {
          method: "POST",
          headers,
          body: JSON.stringify({ url, ...(tenant === undefined ? {} : { tenant }) }),
        });
      } catch {
        return { kind: "retry" };
      }
      let payload: unknown = null;
      try {
        payload = await res.json();
      } catch {
        payload = null;
      }
      if (res.status === 202 || res.status === 200) {
        const jobId =
          typeof payload === "object" && payload !== null
            ? (payload as Record<string, unknown>).job_id
            : null;
        return typeof jobId === "string"
          ? { kind: "job", jobId }
          : { kind: "fatal", error: "no_job_id" };
      }
      return classify(res, payload);
    },

    async poll(jobId: string): Promise<PollResult> {
      let res: Response;
      try {
        res = await fetch(`${base}/v1/jobs/${encodeURIComponent(jobId)}`, {
          method: "GET",
          headers,
        });
      } catch {
        return { kind: "retry" };
      }
      let payload: unknown = null;
      try {
        payload = await res.json();
      } catch {
        payload = null;
      }
      if (res.status === 404) return { kind: "not_found" };
      if (!res.ok) {
        if (res.status === 429 || res.status >= 500) return { kind: "retry" };
        return {
          kind: "fatal",
          error: bodyErrorCode(payload) ?? `http_${res.status}`,
        };
      }
      const view = payload as {
        status?: string;
        result?: TranscriptDoc;
        error?: { code?: string };
      };
      if (view.status === "queued" || view.status === "running") {
        return { kind: view.status };
      }
      if (view.status === "done" && view.result !== undefined) {
        return { kind: "done", result: view.result };
      }
      if (view.status === "failed") {
        return {
          kind: "failed",
          error:
            typeof view.error?.code === "string" ? view.error.code : "job_failed",
        };
      }
      return { kind: "fatal", error: "bad_job_view" };
    },
  };
}
