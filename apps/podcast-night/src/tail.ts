import type { PodcastConfig } from "./config.js";
import { deadlineInstant } from "./deadlines.js";
import { SLOTS, transcriptForSlot, type Slot } from "./fold.js";
import { sha256Hex, type GhStore } from "./github.js";
import type {
  EpisodeRequest,
  EpisodeScript,
  EpisodeSource,
  JobPoll,
  JobTool,
  VoiceRequest,
  VoiceResult,
} from "./jobtool.js";
import { foldReceipts, type Receipt, type ReceiptStatus } from "./receipt.js";
import {
  summaryBody,
  summaryMarker,
  type IssueComments,
} from "./summary.js";
import type { TranscriptDoc } from "./tool1.js";

/** One try and one fill (RFC-001). */
export const TAIL_MAX_ATTEMPTS = 2;
export const PROFILE = "podcast-zh-tw-10min";
/** Voice settings of RFC-004; the router sends them with every voice job. */
export const VOICE = { engine: "edge", name: "zh-TW-HsiaoChenNeural", rate: "-12%" } as const;
/** Spike agentfleet-team/fisheraiagent#74: characters spoken per audio minute at -12%. */
export const CHARS_PER_MINUTE = 262;
/** The audio must last 80% to 120% of the time the script length predicts. */
export const BAND_LOW = 0.8;
export const BAND_HIGH = 1.2;

export type TailNode = "content" | "voice" | "check" | "deliver" | "summary";

export type TailPlan =
  | { kind: "content"; attempt: number }
  | { kind: "voice"; attempt: number }
  | { kind: "check" }
  | { kind: "deliver" }
  | { kind: "summary" }
  | { kind: "escalate"; node: "content"; attempt: number; error: string };

export function isTailPlan(plan: { kind: string }): plan is TailPlan {
  return (
    plan.kind === "content" ||
    plan.kind === "voice" ||
    plan.kind === "check" ||
    plan.kind === "deliver" ||
    plan.kind === "summary" ||
    plan.kind === "escalate"
  );
}

export interface VideoMeta {
  title: string;
  channel: string;
  published?: string;
}

export interface TailDeps {
  store: GhStore;
  tool2: JobTool<EpisodeRequest, EpisodeScript>;
  tool3: JobTool<VoiceRequest, VoiceResult>;
  comments: IssueComments;
  now: Date;
  /** Title, channel and age of a picked video; the pool node supplies them when it exists. */
  videoMeta?: (videoId: string, slot: number) => VideoMeta | undefined;
}

export interface TailNodeResult {
  appended: Receipt | null;
  proceed: boolean;
  log: string[];
}

export interface TailEnv {
  deps: TailDeps;
  date: string;
  runsDir: string;
  summaryIssue: number;
  lines: string[];
  config: PodcastConfig;
  append(
    node: string,
    status: ReceiptStatus,
    attempt: number,
    inputSha256: string | null,
    output: Record<string, unknown>,
    error: string | null,
  ): Promise<{ receipt: Receipt | null; reason?: string }>;
  put(path: string, text: string, message: string): Promise<boolean>;
  /** Create-only write; returns the text that stands (the winner's when the create lost). */
  pin(path: string, text: string, message: string): Promise<string | null>;
}

/** `expect_seconds` for a script of this length. The router and `check` use the same band. */
export function expectSeconds(chars: number): { min: number; max: number } {
  const expected = (chars / CHARS_PER_MINUTE) * 60;
  return { min: Math.floor(expected * BAND_LOW), max: Math.ceil(expected * BAND_HIGH) };
}

type SlotState = "ready" | "empty" | "pending";

function slotState(byNode: Map<string, Receipt>, slot: Slot): SlotState {
  const pick = byNode.get(`pick-${slot}`);
  if (pick === undefined || pick.status !== "done") return "pending";
  if (typeof pick.output.video_id !== "string") return "empty";
  const receipt = byNode.get(`transcript-${slot}`);
  if (receipt === undefined) return "pending";
  if (receipt.status === "done" || receipt.status === "filled") return "ready";
  if (receipt.status === "escalated") return "empty";
  return transcriptForSlot(byNode, slot).kind === "none" ? "empty" : "pending";
}

function nextAttempt(receipt: Receipt | undefined): number | null {
  if (receipt === undefined) return 1;
  if (receipt.status !== "failed") return null;
  return receipt.attempt < TAIL_MAX_ATTEMPTS ? receipt.attempt + 1 : null;
}

function settled(receipt: Receipt | undefined): boolean {
  return receipt !== undefined && (receipt.status === "done" || receipt.status === "filled");
}

/**
 * The tail of RFC-001: `content` once the `content_at` time has come, then
 * `voice`, `check`, `deliver`, and in trial mode the summary. At the cutoff
 * a slot that is still pending — pick or transcript unfinished — counts as
 * missing: with no ready transcript at all the night escalates `content`
 * once. An `escalated` receipt on any node ends the night.
 */
export function planTail(
  lines: string[],
  now: Date,
  date: string,
  config: PodcastConfig,
): TailPlan | null {
  if (!config.enabled) return null;
  if (now.getTime() < Date.parse(`${date}T${config.content_at}:00+08:00`)) return null;
  const byNode = foldReceipts(lines);
  const states = SLOTS.map((slot) => slotState(byNode, slot));

  const content = byNode.get("content");
  if (!settled(content)) {
    const attempt = nextAttempt(content);
    if (attempt === null) return null;
    if (!states.includes("ready")) {
      return { kind: "escalate", node: "content", attempt, error: "no_transcripts" };
    }
    return { kind: "content", attempt };
  }
  const voice = byNode.get("voice");
  if (!settled(voice)) {
    const attempt = nextAttempt(voice);
    return attempt === null ? null : { kind: "voice", attempt };
  }
  if (byNode.get("check") === undefined) return { kind: "check" };
  if (!settled(byNode.get("check"))) return null;
  if (byNode.get("deliver") === undefined) return { kind: "deliver" };
  if (!settled(byNode.get("deliver"))) return null;
  const mode = byNode.get("config")?.output.mode ?? config.mode;
  if (mode === "trial" && byNode.get("summary") === undefined) {
    return { kind: "summary" };
  }
  return null;
}

function scriptPath(env: TailEnv): string {
  return `${env.runsDir}/${env.date}/script.json`;
}

function transcriptFile(env: TailEnv, slot: number): string {
  return `${env.runsDir}/${env.date}/transcript-${slot}.json`;
}

function youtubeUrl(videoId: string): string {
  return `https://www.youtube.com/watch?v=${videoId}`;
}

interface JobSpec<Req, Res> {
  node: "content" | "voice";
  attempt: number;
  body: Req;
  input: string;
  tool: JobTool<Req, Res>;
  /** Writes what the router keeps and returns the receipt output, or null to wait. */
  onDone(result: Res): Promise<Record<string, unknown> | string | null>;
}

/**
 * One try of a tool 2 or tool 3 job. The request body is pinned to a file
 * (create-only: the first writer wins and a loser uses the winner's file)
 * before the first submit, so every later submit of this node — the fill or
 * a resubmit after a crash — sends the identical body even when the config
 * or metadata changed since. The first try sends `<date>/<node>` as the
 * `Idempotency-Key`, so a resubmit after a crash replays the same job. The
 * fill sends `<date>/<node>#2`: the key of a failed job would replay the
 * failure. A failed first try appends `failed`; a failed fill appends
 * `escalated`. A job still queued or running at the node deadline ends the
 * try the same way.
 */
async function runJob<Req, Res>(
  env: TailEnv,
  spec: JobSpec<Req, Res>,
): Promise<TailNodeResult> {
  const { node, attempt } = spec;
  const key = attempt === 1 ? `${env.date}/${node}` : `${env.date}/${node}#${attempt}`;

  const requestPath = `${env.runsDir}/${env.date}/${node}-request.json`;
  let body = spec.body;
  const pinned = await env.deps.store.readFile(requestPath);
  let pinnedText = pinned?.text ?? null;
  if (pinnedText === null) {
    pinnedText = await env.pin(
      requestPath,
      `${JSON.stringify(body)}\n`,
      `podcast-night: ${env.date}/${node} request`,
    );
  }
  if (pinnedText === null) {
    return {
      appended: null,
      proceed: false,
      log: [`node=${node} wait=request_file_conflict`],
    };
  }
  try {
    body = JSON.parse(pinnedText) as Req;
  } catch {
    return {
      appended: null,
      proceed: false,
      log: [`node=${node} wait=request_file_invalid`],
    };
  }

  const fail = async (error: string): Promise<TailNodeResult> => {
    const status = attempt >= TAIL_MAX_ATTEMPTS ? "escalated" : "failed";
    const { receipt, reason } = await env.append(node, status, attempt, spec.input, {}, error);
    return {
      appended: receipt,
      proceed: receipt !== null,
      log: [`node=${node} status=${status} error=${error} appended=${receipt !== null}${reason ? ` reason=${reason}` : ""}`],
    };
  };
  const wait = (why: string): TailNodeResult => ({
    appended: null,
    proceed: false,
    log: [`node=${node} wait=${why}`],
  });

  const submit = await spec.tool.submit(body, key);
  if (submit.kind === "retry") return wait("submit_retry");
  if (submit.kind === "fatal") return fail(submit.error);
  let poll: JobPoll<Res> = await spec.tool.poll(submit.jobId);
  if (poll.kind === "not_found") {
    const again = await spec.tool.submit(body, key);
    if (again.kind !== "job") return wait(`resubmit_${again.kind}`);
    poll = await spec.tool.poll(again.jobId);
  }
  if (poll.kind === "failed" || poll.kind === "fatal") return fail(poll.error);
  if (poll.kind !== "done") {
    const deadline = deadlineInstant(env.date, node);
    if (
      (poll.kind === "queued" || poll.kind === "running") &&
      deadline !== null &&
      env.deps.now.getTime() >= deadline
    ) {
      return fail("deadline_exceeded");
    }
    return wait(`job_${poll.kind}`);
  }
  const output = await spec.onDone(poll.result);
  if (output === null) return wait("file_conflict");
  if (typeof output === "string") return fail(output);
  const { receipt, reason } = await env.append(node, "done", attempt, spec.input, output, null);
  return {
    appended: receipt,
    proceed: receipt !== null,
    log: [`node=${node} status=done appended=${receipt !== null}${reason ? ` reason=${reason}` : ""}`],
  };
}

async function escalate(
  env: TailEnv,
  node: string,
  attempt: number,
  error: string,
): Promise<TailNodeResult> {
  const { receipt, reason } = await env.append(node, "escalated", attempt, null, {}, error);
  return {
    appended: receipt,
    proceed: false,
    log: [`node=${node} status=escalated error=${error} appended=${receipt !== null}${reason ? ` reason=${reason}` : ""}`],
  };
}

async function runContent(
  env: TailEnv,
  plan: Extract<TailPlan, { kind: "content" }>,
): Promise<TailNodeResult> {
  const byNode = foldReceipts(env.lines);
  const sources: EpisodeSource[] = [];
  const missing: number[] = [];
  const shas: string[] = [];
  for (const slot of SLOTS) {
    if (slotState(byNode, slot) !== "ready") {
      missing.push(slot);
      continue;
    }
    const file = await env.deps.store.readFile(transcriptFile(env, slot));
    if (file === null) return escalate(env, "content", plan.attempt, `transcript_file_missing:${slot}`);
    let transcript: TranscriptDoc;
    try {
      transcript = JSON.parse(file.text) as TranscriptDoc;
    } catch {
      return escalate(env, "content", plan.attempt, `transcript_file_invalid:${slot}`);
    }
    const meta = env.deps.videoMeta?.(transcript.video_id, slot);
    const topic = env.config.topics.find((t) => t.slot === slot);
    sources.push({
      slot,
      title: meta?.title ?? topic?.name ?? transcript.video_id,
      channel: meta?.channel ?? "YouTube",
      url: youtubeUrl(transcript.video_id),
      ...(meta?.published === undefined ? {} : { published: meta.published }),
      transcript,
    });
    shas.push(`${slot}:${await sha256Hex(file.text)}`);
  }
  const body: EpisodeRequest = { profile: PROFILE, date: env.date, sources, missing_slots: missing };
  const input = await sha256Hex(`${env.date}/content|${shas.join(",")}|${missing.join(",")}`);
  return runJob(env, {
    node: "content",
    attempt: plan.attempt,
    body,
    input,
    tool: env.deps.tool2,
    async onDone(script) {
      if (!Array.isArray(script.sections) || typeof script.char_count !== "number") {
        return "bad_result";
      }
      const text = `${JSON.stringify({
        title: script.title,
        char_count: script.char_count,
        sections: script.sections,
      })}\n`;
      const ok = await env.put(scriptPath(env), text, `podcast-night: ${env.date}/script`);
      if (!ok) return null;
      return {
        chars: script.char_count,
        script_sha256: await sha256Hex(text),
        path: scriptPath(env),
        file_id: script.saved?.file_id ?? null,
      };
    },
  });
}

async function runVoice(
  env: TailEnv,
  plan: Extract<TailPlan, { kind: "voice" }>,
): Promise<TailNodeResult> {
  const content = foldReceipts(env.lines).get("content");
  const chars = content?.output.chars;
  const file = await env.deps.store.readFile(scriptPath(env));
  if (file === null || typeof chars !== "number") {
    return escalate(env, "voice", plan.attempt, "script_missing");
  }
  let script: { sections?: { id: string; text: string }[] };
  try {
    script = JSON.parse(file.text) as typeof script;
  } catch {
    return escalate(env, "voice", plan.attempt, "script_invalid");
  }
  if (!Array.isArray(script.sections)) return escalate(env, "voice", plan.attempt, "script_invalid");
  const body: VoiceRequest = {
    date: env.date,
    voice: { ...VOICE },
    sections: script.sections.map((s) => ({ id: s.id, text: s.text })),
    expect_seconds: expectSeconds(chars),
  };
  const input = await sha256Hex(
    `${env.date}/voice|${await sha256Hex(file.text)}|${VOICE.name}|${VOICE.rate}`,
  );
  return runJob(env, {
    node: "voice",
    attempt: plan.attempt,
    body,
    input,
    tool: env.deps.tool3,
    async onDone(result) {
      if (typeof result.duration_s !== "number") return "bad_result";
      return {
        duration_s: result.duration_s,
        bytes: result.bytes,
        audio_sha256: result.sha256,
        audio_file_id: result.saved?.audio_file_id ?? null,
        marks_file_id: result.saved?.marks_file_id ?? null,
      };
    },
  });
}

async function runCheck(env: TailEnv): Promise<TailNodeResult> {
  const byNode = foldReceipts(env.lines);
  const chars = byNode.get("content")?.output.chars;
  const duration = byNode.get("voice")?.output.duration_s;
  if (typeof chars !== "number" || typeof duration !== "number") {
    return escalate(env, "check", 1, "receipt_fields_missing");
  }
  const band = expectSeconds(chars);
  if (duration < band.min || duration > band.max) {
    return escalate(env, "check", 1, `duration_out_of_band:${duration}:${band.min}-${band.max}`);
  }
  const { receipt, reason } = await env.append(
    "check",
    "done",
    1,
    null,
    { chars, duration_s: duration },
    null,
  );
  return {
    appended: receipt,
    proceed: receipt !== null,
    log: [`node=check status=done appended=${receipt !== null}${reason ? ` reason=${reason}` : ""}`],
  };
}

async function runDeliver(env: TailEnv): Promise<TailNodeResult> {
  const byNode = foldReceipts(env.lines);
  const ids = {
    content: byNode.get("content")?.output.file_id,
    audio: byNode.get("voice")?.output.audio_file_id,
    marks: byNode.get("voice")?.output.marks_file_id,
  };
  const absent = Object.entries(ids)
    .filter(([, id]) => typeof id !== "string" || id === "")
    .map(([name]) => name);
  if (absent.length > 0) {
    return escalate(env, "deliver", 1, `file_id_missing:${absent.join(",")}`);
  }
  const { receipt, reason } = await env.append("deliver", "done", 1, null, {}, null);
  return {
    appended: receipt,
    proceed: receipt !== null,
    log: [`node=deliver status=done appended=${receipt !== null}${reason ? ` reason=${reason}` : ""}`],
  };
}

async function runSummary(env: TailEnv): Promise<TailNodeResult> {
  const marker = summaryMarker(env.date);
  const since = new Date(Date.parse(`${env.date}T00:00:00+08:00`)).toISOString();
  let posted = false;
  try {
    posted = await env.deps.comments.hasComment(env.summaryIssue, marker, since);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { appended: null, proceed: false, log: [`node=summary wait=comment_failed error=${message}`] };
  }
  if (!posted) {
    // Claim the post for this date in the record before sending: the CAS
    // append is the lock, so two ticks that both miss the marker can never
    // both post.
    const claim = await env.append("summary", "done", 1, null, {}, null);
    if (claim.receipt === null) {
      return {
        appended: null,
        proceed: false,
        log: [`node=summary wait=claim${claim.reason ? ` reason=${claim.reason}` : ""}`],
      };
    }
    try {
      await env.deps.comments.post(env.summaryIssue, summaryBody(env.date, env.lines));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        appended: claim.receipt,
        proceed: true,
        log: [`node=summary status=done appended=true comment_failed error=${message}`],
      };
    }
    return { appended: claim.receipt, proceed: true, log: ["node=summary status=done appended=true"] };
  }
  const { receipt, reason } = await env.append("summary", "done", 1, null, {}, null);
  return {
    appended: receipt,
    proceed: receipt !== null,
    log: [`node=summary status=done appended=${receipt !== null}${reason ? ` reason=${reason}` : ""}`],
  };
}

export async function runTailNode(env: TailEnv, plan: TailPlan): Promise<TailNodeResult> {
  switch (plan.kind) {
    case "content":
      return runContent(env, plan);
    case "voice":
      return runVoice(env, plan);
    case "check":
      return runCheck(env);
    case "deliver":
      return runDeliver(env);
    case "summary":
      return runSummary(env);
    case "escalate":
      return escalate(env, plan.node, plan.attempt, plan.error);
  }
}
