import { parseConfig, type PodcastConfig } from "./config.js";
import {
  fold,
  MAX_NODES_PER_TICK,
  isTerminal,
  planConfig,
  SLOTS,
  taipeiDate,
  type Plan,
  type Slot,
} from "./fold.js";
import { githubStore, sha256Hex, type GhStore } from "./github.js";
import { httpJobTool, type JobTool } from "./jobtool.js";
import type { EpisodeRequest, EpisodeScript, VoiceRequest, VoiceResult } from "./jobtool.js";
import { foldReceipts, parseReceiptLine, type Receipt, type ReceiptStatus } from "./receipt.js";
import { collectPool, POOL_MAX_ATTEMPTS, type PoolCandidate } from "./selection/pool.js";
import { fetchResultsPage, type PageFetch } from "./selection/search.js";
import { githubComments, type IssueComments } from "./summary.js";
import { isTailPlan, planTail, runTailNode, type TailPlan, type VideoMeta } from "./tail.js";
import { httpTool1, type PollResult, type Tool1, type TranscriptDoc } from "./tool1.js";

export const WORKER_BY = "podcast-night@0.1.0";
const RUNS_DIR = "research/morning-podcast/runs";
const CONFIG_PATH = "research/morning-podcast/config.json";
const MAX_APPEND_WRITES = 2;

export interface Env {
  GITHUB_TOKEN?: string;
  PODCAST_CALLER_TOKEN?: string;
  TOOL1_BASE_URL?: string;
  TOOL2_BASE_URL?: string;
  TOOL3_BASE_URL?: string;
  STATE_REPO?: string;
  SUMMARY_REPO?: string;
  SUMMARY_ISSUE?: string;
  DRY_RUN?: string;
}

export interface InstanceEnv {
  stateRepo: string;
  summaryRepo: string;
  summaryIssue: number;
}

const REPO_SLUG_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const POSITIVE_INT_RE = /^[1-9]\d*$/;

function parseRepoSlug(value: unknown): string | null {
  if (typeof value !== "string" || !REPO_SLUG_RE.test(value)) return null;
  const [owner, repo] = value.split("/");
  if (owner === "." || owner === ".." || repo === "." || repo === "..") return null;
  return value;
}

function parsePositiveInt(value: unknown): number | null {
  if (typeof value !== "string" || !POSITIVE_INT_RE.test(value)) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** Validates required deployment-instance vars (`STATE_REPO`, `SUMMARY_REPO`, `SUMMARY_ISSUE`). */
export function parseInstanceEnv(
  env: Partial<Pick<Env, "STATE_REPO" | "SUMMARY_REPO" | "SUMMARY_ISSUE">> | undefined,
): { ok: true; config: InstanceEnv } | { ok: false; error: string } {
  const check = (name: string, raw: unknown): string | null =>
    raw === undefined || raw === "" ? `missing_env:${name}` : `invalid_env:${name}`;

  const stateRepo = parseRepoSlug(env?.STATE_REPO);
  if (stateRepo === null) return { ok: false, error: check("STATE_REPO", env?.STATE_REPO)! };

  const summaryRepo = parseRepoSlug(env?.SUMMARY_REPO);
  if (summaryRepo === null) return { ok: false, error: check("SUMMARY_REPO", env?.SUMMARY_REPO)! };

  const summaryIssue = parsePositiveInt(env?.SUMMARY_ISSUE);
  if (summaryIssue === null) {
    return { ok: false, error: check("SUMMARY_ISSUE", env?.SUMMARY_ISSUE)! };
  }

  return { ok: true, config: { stateRepo, summaryRepo, summaryIssue } };
}

export interface TickDeps {
  store: GhStore;
  tool1: Tool1;
  tool2: JobTool<EpisodeRequest, EpisodeScript>;
  tool3: JobTool<VoiceRequest, VoiceResult>;
  comments: IssueComments;
  env: Partial<Pick<Env, "STATE_REPO" | "SUMMARY_REPO" | "SUMMARY_ISSUE">>;
  videoMeta?: (videoId: string, slot: number) => VideoMeta | undefined;
  now: Date;
  dryRun: boolean;
  by?: string;
  runsDir?: string;
  configPath?: string;
  /** The results-page fetch the `pool` node runs; tests inject a fake. */
  search?: PageFetch;
}

export interface TickOutcome {
  date: string;
  ok: boolean;
  error?: string;
  appended: Receipt[];
  lines: string[];
}

function youtubeUrl(videoId: string): string {
  return `https://www.youtube.com/watch?v=${videoId}`;
}

function transcriptPath(runsDir: string, date: string, slot: Slot): string {
  return `${runsDir}/${date}/transcript-${slot}.json`;
}

function poolPath(runsDir: string, date: string): string {
  return `${runsDir}/${date}/pool.json`;
}

/** The committed candidate list the `pool` node wrote, or null. */
async function readPool(store: GhStore, path: string): Promise<PoolCandidate[] | null> {
  const file = await store.readFile(path);
  if (file === null) return null;
  try {
    const doc: unknown = JSON.parse(file.text);
    if (typeof doc !== "object" || doc === null) return null;
    const candidates = (doc as Record<string, unknown>).candidates;
    return Array.isArray(candidates) ? (candidates as PoolCandidate[]) : null;
  } catch {
    return null;
  }
}

function recordPath(runsDir: string, date: string): string {
  return `${runsDir}/${date}.jsonl`;
}

interface RecordRead {
  sha: string | null;
  lines: string[];
}

async function readRecord(store: GhStore, path: string): Promise<RecordRead> {
  const file = await store.readFile(path);
  if (file === null) return { sha: null, lines: [] };
  return {
    sha: file.sha,
    lines: file.text.split("\n").filter((line) => line.trim() !== ""),
  };
}

function makeReceipt(
  date: string,
  node: string,
  status: ReceiptStatus,
  attempt: number,
  inputSha256: string | null,
  output: Record<string, unknown>,
  error: string | null,
  at: Date,
  by: string,
): Receipt {
  return {
    v: 1,
    date,
    node,
    key: `${date}/${node}`,
    status,
    attempt,
    input_sha256: inputSha256,
    output,
    error,
    at: at.toISOString(),
    by,
  };
}

/**
 * Appends one receipt by compare-and-set: the PUT carries the sha the tick
 * read, so a lost race comes back 409; the tick then reads again, re-folds
 * (a winner already wrote this node → nothing to do) and appends once. A
 * second 409 ends the tick with no write.
 */
async function appendReceipt(
  store: GhStore,
  path: string,
  record: RecordRead,
  receipt: Receipt,
): Promise<{ appended: boolean; reason?: string }> {
  let current = record;
  for (let writes = 0; writes < MAX_APPEND_WRITES; writes += 1) {
    const text = [...current.lines, JSON.stringify(receipt)].join("\n") + "\n";
    const result = await store.writeFile(
      path,
      text,
      current.sha,
      `podcast-night: ${receipt.key} ${receipt.status}`,
    );
    if (result === "ok") return { appended: true };
    current = await readRecord(store, path);
    const latest = foldReceipts(current.lines).get(receipt.node);
    if (latest !== undefined && latest.attempt >= receipt.attempt) {
      return { appended: false, reason: "already_present" };
    }
  }
  return { appended: false, reason: "conflict" };
}

/** Writes a file next to the record; same CAS budget as appendReceipt. */
async function putFile(
  store: GhStore,
  path: string,
  text: string,
  message: string,
): Promise<boolean> {
  let file = await store.readFile(path);
  if (file !== null && file.text === text) return true;
  for (let writes = 0; writes < MAX_APPEND_WRITES; writes += 1) {
    const result = await store.writeFile(path, text, file?.sha ?? null, message);
    if (result === "ok") return true;
    file = await store.readFile(path);
    if (file !== null && file.text === text) return true;
  }
  return false;
}

/**
 * Creates a file only when it does not exist (contents API with no sha) and
 * returns the text that stands: ours when the create won, the winner's when
 * it lost. Null when the winner cannot be read. Never updates a file.
 */
async function createOnce(
  store: GhStore,
  path: string,
  text: string,
  message: string,
): Promise<string | null> {
  const result = await store.writeFile(path, text, null, message);
  if (result === "ok") return text;
  const winner = await store.readFile(path);
  return winner === null ? null : winner.text;
}

/**
 * Video ids claimed by earlier nights' records (PRD story 8). Every
 * valid receipt line counts, not only the last per node: a superseded
 * attempt already consumed its video (a failed submit still reached
 * the tool), so its id stays reserved.
 */
async function usedVideoIds(
  store: GhStore,
  runsDir: string,
  date: string,
): Promise<Set<string>> {
  const used = new Set<string>();
  const names = await store.listDir(runsDir);
  for (const name of names) {
    if (!/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name) || name === `${date}.jsonl`) {
      continue;
    }
    const file = await store.readFile(`${runsDir}/${name}`);
    if (file === null) continue;
    for (const line of file.text.split("\n")) {
      const receipt = parseReceiptLine(line);
      if (receipt === null) continue;
      for (const key of ["video_id", "backup_id"] as const) {
        const value = receipt.output[key];
        if (typeof value === "string") used.add(value);
      }
    }
  }
  return used;
}

interface NodeResult {
  appended: Receipt | null;
  proceed: boolean;
  log: string[];
}

function jobReceipt(
  deps: TickDeps,
  plan: Extract<Plan, { kind: "transcript-job" }>,
  date: string,
  status: ReceiptStatus,
  error: string | null,
  input: string,
  result?: TranscriptDoc,
): Receipt {
  const output: Record<string, unknown> = { video_id: plan.videoId };
  if (result !== undefined) {
    output.source = result.source ?? "gemini";
    output.blocks = Array.isArray(result.blocks) ? result.blocks.length : 0;
    output.path = transcriptPath(deps.runsDir ?? RUNS_DIR, date, plan.slot);
  }
  return makeReceipt(
    date,
    `transcript-${plan.slot}`,
    status,
    plan.attempt,
    input,
    output,
    error,
    deps.now,
    deps.by ?? WORKER_BY,
  );
}

/**
 * One `transcript-<n>` node run: submit, then poll. The tool has no
 * idempotency header, so this sends at most one POST per call plus one
 * resubmit after a `not_found` (tool restart); dedupe is the tool's
 * per-video cache.
 */
async function runTranscriptJob(
  deps: TickDeps,
  plan: Extract<Plan, { kind: "transcript-job" }>,
  date: string,
  record: RecordRead,
  path: string,
  by: string,
): Promise<NodeResult> {
  const node = `transcript-${plan.slot}`;
  const url = youtubeUrl(plan.videoId);
  const input = await sha256Hex(`${date}/${node}|${plan.videoId}`);
  const submit = await deps.tool1.submit(url);
  if (submit.kind === "retry") {
    return { appended: null, proceed: false, log: [`node=${node} wait=submit_retry`] };
  }
  if (submit.kind === "fatal") {
    const receipt = jobReceipt(deps, plan, date, "failed", submit.error, input, undefined);
    const { appended, reason } = await appendReceipt(deps.store, path, record, receipt);
    return {
      appended: appended ? receipt : null,
      proceed: appended,
      log: [`node=${node} submit_fatal=${submit.error} appended=${appended}${reason ? ` reason=${reason}` : ""}`],
    };
  }
  let poll = await deps.tool1.poll(submit.jobId);
  if (poll.kind === "not_found") {
    const again = await deps.tool1.submit(url);
    if (again.kind !== "job") {
      return { appended: null, proceed: false, log: [`node=${node} wait=resubmit_${again.kind}`] };
    }
    poll = await deps.tool1.poll(again.jobId);
  }
  return finishPoll(deps, plan, date, record, path, by, input, poll);
}

async function finishPoll(
  deps: TickDeps,
  plan: Extract<Plan, { kind: "transcript-job" }>,
  date: string,
  record: RecordRead,
  path: string,
  by: string,
  input: string,
  poll: PollResult,
): Promise<NodeResult> {
  const node = `transcript-${plan.slot}`;
  if (poll.kind === "done") {
    const text = `${JSON.stringify(poll.result)}\n`;
    const ok = await putFile(
      deps.store,
      transcriptPath(deps.runsDir ?? RUNS_DIR, date, plan.slot),
      text,
      `podcast-night: ${date}/transcript-${plan.slot}`,
    );
    if (!ok) {
      return { appended: null, proceed: false, log: [`node=${node} wait=file_conflict`] };
    }
    const receipt = jobReceipt(deps, plan, date, plan.isBackup ? "filled" : "done", null, input, poll.result);
    receipt.output.transcript_sha256 = await sha256Hex(text);
    const { appended, reason } = await appendReceipt(deps.store, path, record, receipt);
    return {
      appended: appended ? receipt : null,
      proceed: appended,
      log: [`node=${node} status=${receipt.status} appended=${appended}${reason ? ` reason=${reason}` : ""}`],
    };
  }
  if (poll.kind === "failed" || poll.kind === "fatal") {
    const error = poll.error;
    const receipt = jobReceipt(deps, plan, date, "failed", error, input);
    const { appended, reason } = await appendReceipt(deps.store, path, record, receipt);
    return {
      appended: appended ? receipt : null,
      proceed: appended,
      log: [`node=${node} status=failed error=${error} appended=${appended}${reason ? ` reason=${reason}` : ""}`],
    };
  }
  return { appended: null, proceed: false, log: [`node=${node} wait=job_${poll.kind}`] };
}

function runTail(
  deps: TickDeps,
  plan: TailPlan,
  config: PodcastConfig,
  date: string,
  record: RecordRead,
  path: string,
  by: string,
  summaryIssue: number,
): Promise<NodeResult> {
  return runTailNode(
    {
      deps,
      date,
      runsDir: deps.runsDir ?? RUNS_DIR,
      summaryIssue,
      lines: record.lines,
      config,
      async append(node, status, attempt, inputSha256, output, error) {
        const receipt = makeReceipt(date, node, status, attempt, inputSha256, output, error, deps.now, by);
        const { appended, reason } = await appendReceipt(deps.store, path, record, receipt);
        return { receipt: appended ? receipt : null, reason };
      },
      put: (filePath, text, message) => putFile(deps.store, filePath, text, message),
      pin: (filePath, text, message) => createOnce(deps.store, filePath, text, message),
    },
    plan,
  );
}

/**
 * One `pool` node run (RFC-003): a week-filtered search per topic
 * query, a month second search for a topic with no week candidates,
 * then the quality bar and the fixed score. The candidate list
 * commits next to the record before its receipt. A failed run retries
 * once, then escalates, and picks fall back to the backlog (RFC-001).
 */
async function runPoolNode(
  deps: TickDeps,
  plan: Extract<Plan, { kind: "pool" }>,
  date: string,
  record: RecordRead,
  path: string,
  by: string,
  config: PodcastConfig,
): Promise<NodeResult> {
  const node = "pool";
  const runsDir = deps.runsDir ?? RUNS_DIR;
  const used = await usedVideoIds(deps.store, runsDir, date);
  const input = await sha256Hex(
    `${date}/${node}|${JSON.stringify({ topics: config.topics, backlog: config.backlog, used: [...used].sort() })}`,
  );
  const outcome = await collectPool({
    config,
    usedVideoIds: used,
    fetch: deps.search ?? fetchResultsPage,
  });
  if (!outcome.ok) {
    const status = plan.attempt >= POOL_MAX_ATTEMPTS ? "escalated" : "failed";
    const receipt = makeReceipt(
      date,
      node,
      status,
      plan.attempt,
      input,
      { source: "worker" },
      outcome.error,
      deps.now,
      by,
    );
    const { appended, reason } = await appendReceipt(deps.store, path, record, receipt);
    return {
      appended: appended ? receipt : null,
      proceed: appended,
      log: [`node=${node} status=${status} error=${outcome.error} appended=${appended}${reason ? ` reason=${reason}` : ""}`],
    };
  }
  const listPath = poolPath(runsDir, date);
  const text = `${JSON.stringify({
    v: 1,
    date,
    source: "worker",
    generated_at: deps.now.toISOString(),
    searches: outcome.searches,
    candidates: outcome.candidates,
  })}\n`;
  const ok = await putFile(
    deps.store,
    listPath,
    text,
    `podcast-night: ${date}/pool`,
  );
  if (!ok) {
    return { appended: null, proceed: false, log: [`node=${node} wait=file_conflict`] };
  }
  const receipt = makeReceipt(
    date,
    node,
    "done",
    plan.attempt,
    input,
    {
      count: outcome.candidates.length,
      pool_sha256: await sha256Hex(text),
      path: listPath,
      source: "worker",
    },
    null,
    deps.now,
    by,
  );
  const { appended, reason } = await appendReceipt(deps.store, path, record, receipt);
  return {
    appended: appended ? receipt : null,
    proceed: appended,
    log: [`node=${node} status=done count=${outcome.candidates.length} appended=${appended}${reason ? ` reason=${reason}` : ""}`],
  };
}

async function runNode(
  deps: TickDeps,
  plan: Exclude<Plan, { kind: "none" }>,
  date: string,
  record: RecordRead,
  path: string,
  by: string,
  config: PodcastConfig | null,
): Promise<NodeResult> {
  if (plan.kind === "pool") {
    if (config === null) {
      return { appended: null, proceed: false, log: [`node=pool wait=no_config`] };
    }
    return runPoolNode(deps, plan, date, record, path, by, config);
  }
  if (plan.kind === "config") {
    const receipt = makeReceipt(
      date,
      "config",
      plan.status,
      plan.attempt,
      null,
      plan.status === "done"
        ? {
            config_sha: plan.configSha ?? null,
            enabled: plan.enabled ?? null,
            mode: plan.mode ?? null,
          }
        : {},
      plan.status === "escalated" ? (plan.error ?? "config_error") : null,
      deps.now,
      by,
    );
    const { appended, reason } = await appendReceipt(deps.store, path, record, receipt);
    return {
      appended: appended ? receipt : null,
      proceed: appended,
      log: [`node=config status=${plan.status} appended=${appended}${reason ? ` reason=${reason}` : ""}`],
    };
  }
  if (plan.kind === "pick") {
    const receipt = makeReceipt(
      date,
      `pick-${plan.slot}`,
      "done",
      1,
      null,
      {
        video_id: plan.videoId,
        backup_id: plan.backupId,
        score: plan.score,
        reason: plan.reason,
      },
      null,
      deps.now,
      by,
    );
    const { appended, reason } = await appendReceipt(deps.store, path, record, receipt);
    return {
      appended: appended ? receipt : null,
      proceed: appended,
      log: [`node=pick-${plan.slot} video=${plan.videoId ?? "none"} appended=${appended}${reason ? ` reason=${reason}` : ""}`],
    };
  }
  return runTranscriptJob(deps, plan, date, record, path, by);
}

/**
 * One router tick (Amendment 1, #1900): runs due nodes one after another,
 * appending each receipt before the next node starts, and stops at the
 * first node that must wait — a tool job still running or a slot not yet
 * open — or after five nodes.
 */
export async function runTick(deps: TickDeps): Promise<TickOutcome> {
  const date = taipeiDate(deps.now);
  const instance = parseInstanceEnv(deps.env);
  if (!instance.ok) {
    return {
      date,
      ok: false,
      error: instance.error,
      appended: [],
      lines: [`tick ${date} error=${instance.error}`],
    };
  }
  const runsDir = deps.runsDir ?? RUNS_DIR;
  const configPath = deps.configPath ?? CONFIG_PATH;
  const by = deps.by ?? WORKER_BY;
  const path = recordPath(runsDir, date);
  const lines: string[] = [];
  const appendedAll: Receipt[] = [];

  for (let nodes = 0; nodes < MAX_NODES_PER_TICK; nodes += 1) {
    const record = await readRecord(deps.store, path);
    const configFile = await deps.store.readFile(configPath);
    const parsed =
      configFile === null
        ? ({ ok: false, error: "config_not_found" } as const)
        : parseConfig(configFile.text);
    const configPlan = planConfig(
      record.lines,
      parsed.ok
        ? { ok: true, config: parsed.config, configSha: configFile?.sha ?? "" }
        : { ok: false, error: parsed.error },
    );
    let plan: Plan | TailPlan;
    let tailConfig: PodcastConfig | null = null;
    if (configPlan !== null) {
      plan = configPlan;
    } else if (!parsed.ok || !parsed.config.enabled) {
      plan = { kind: "none" };
    } else {
      // Once `content_at` has come the tail owns the night: a pick or
      // transcript still unfinished at the cutoff is counted as a missing
      // slot instead of blocking `content` (RFC-001 deadline table).
      // A pool that has not settled keeps its turn ahead of the tail.
      const tail = !isTerminal(foldReceipts(record.lines).get("pool"))
        ? null
        : planTail(record.lines, deps.now, date, parsed.config);
      if (tail !== null) {
        plan = tail;
        tailConfig = parsed.config;
      } else {
        const seen = foldReceipts(record.lines);
        const pickMaybeDue = SLOTS.some(
          (slot) =>
            !seen.has(`pick-${slot}`) &&
            deps.now.getTime() >=
              Date.parse(`${date}T${parsed.config.slots[slot - 1]}:00+08:00`),
        );
        const poolDone = seen.get("pool")?.status === "done";
        plan = fold(record.lines, deps.now, {
          config: parsed.config as PodcastConfig,
          usedVideoIds: pickMaybeDue
            ? await usedVideoIds(deps.store, runsDir, date)
            : new Set<string>(),
          pool:
            pickMaybeDue && poolDone
              ? await readPool(deps.store, poolPath(runsDir, date))
              : null,
        });
      }
    }
    if (plan.kind === "none") {
      lines.push(`tick ${date} node=none`);
      break;
    }
    if (deps.dryRun) {
      lines.push(`tick ${date} DRY plan=${JSON.stringify(plan)}`);
      break;
    }
    const step =
      isTailPlan(plan) && tailConfig !== null
        ? await runTail(deps, plan, tailConfig, date, record, path, by, instance.config.summaryIssue)
        : await runNode(
            deps,
            plan as Exclude<Plan, { kind: "none" }>,
            date,
            record,
            path,
            by,
            parsed.ok ? parsed.config : null,
          );
    lines.push(...step.log);
    if (step.appended !== null) appendedAll.push(step.appended);
    if (!step.proceed) break;
  }
  lines.push(`tick ${date} done appended=${appendedAll.length}`);
  return { date, ok: true, appended: appendedAll, lines };
}

export function buildTickDeps(env: Env, now: Date): TickDeps {
  const instance = parseInstanceEnv(env);
  const stateRepo = instance.ok ? instance.config.stateRepo : "";
  const summaryRepo = instance.ok ? instance.config.summaryRepo : "";
  return {
    store: githubStore(stateRepo, env.GITHUB_TOKEN),
    tool1: httpTool1(
      env.TOOL1_BASE_URL ?? "https://transcripts.agentfleet.team",
      env.PODCAST_CALLER_TOKEN,
    ),
    tool2: httpJobTool<EpisodeRequest, EpisodeScript>(
      env.TOOL2_BASE_URL ?? "https://digest.agentfleet.team",
      env.PODCAST_CALLER_TOKEN,
    ),
    tool3: httpJobTool<VoiceRequest, VoiceResult>(
      env.TOOL3_BASE_URL ?? "https://voice.agentfleet.team",
      env.PODCAST_CALLER_TOKEN,
    ),
    comments: githubComments(summaryRepo, env.GITHUB_TOKEN),
    env: {
      STATE_REPO: env.STATE_REPO,
      SUMMARY_REPO: env.SUMMARY_REPO,
      SUMMARY_ISSUE: env.SUMMARY_ISSUE,
    },
    now,
    dryRun: env.DRY_RUN !== "false",
  };
}

export const worker = {
  async fetch(): Promise<Response> {
    return new Response("Not Found\n", {
      status: 404,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  },

  async scheduled(
    controller: ScheduledController,
    env: Env,
    _ctx?: ExecutionContext,
  ): Promise<void> {
    try {
      const outcome = await runTick(buildTickDeps(env, new Date(controller.scheduledTime)));
      const log = outcome.ok ? console.log : console.error;
      for (const line of outcome.lines) {
        log(line);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`tick error=${message}`);
    }
  },
} satisfies ExportedHandler<Env>;
