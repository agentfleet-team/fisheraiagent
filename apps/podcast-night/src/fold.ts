import type { PodcastConfig } from "./config.js";
import { foldReceipts, type Receipt } from "./receipt.js";
import { pickFromPool } from "./selection/pick.js";
import type { PoolCandidate } from "./selection/pool.js";

export type Slot = 1 | 2 | 3;
export const SLOTS: readonly Slot[] = [1, 2, 3];
/** A transcript node gets at most two tries on its pick, then one on the backup. */
export const TRANSCRIPT_MAX_PRIMARY_ATTEMPTS = 2;
/** A tick stops after this many node runs (Amendment 1, #1900). */
export const MAX_NODES_PER_TICK = 5;

export interface FoldCtx {
  config: PodcastConfig;
  /** Video ids already used by earlier nights' records. */
  usedVideoIds: ReadonlySet<string>;
  /**
   * The night's committed candidate pool (`runs/<date>/pool.json`), or
   * null when the pool is missing or escalated: picks then fall back
   * to the backlog (RFC-001 pool escalation).
   */
  pool: PoolCandidate[] | null;
}

export type Plan =
  | { kind: "pool"; attempt: number }
  | {
      kind: "config";
      status: "done" | "escalated";
      attempt: number;
      configSha?: string;
      enabled?: boolean;
      mode?: string;
      error?: string;
    }
  | {
      kind: "pick";
      slot: Slot;
      videoId: string | null;
      backupId: string | null;
      score: number;
      reason: string;
    }
  | {
      kind: "transcript-job";
      slot: Slot;
      videoId: string;
      attempt: number;
      isBackup: boolean;
    }
  | { kind: "none" };

/** The Taipei calendar date of the delivery this tick works on. */
export function taipeiDate(now: Date): string {
  const formatted = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  return formatted.slice(0, 10);
}

function slotInstant(date: string, hhmm: string): number {
  return Date.parse(`${date}T${hhmm}:00+08:00`);
}

export function isTerminal(receipt: Receipt | undefined): boolean {
  return (
    receipt !== undefined &&
    (receipt.status === "done" ||
      receipt.status === "filled" ||
      receipt.status === "escalated")
  );
}

function pickForSlot(lines: string[], slot: Slot, ctx: FoldCtx): Plan {
  const byNode = foldReceipts(lines);
  const taken = new Set<string>(ctx.usedVideoIds);
  for (const receipt of byNode.values()) {
    if (!receipt.node.startsWith("pick-")) continue;
    if (typeof receipt.output.video_id === "string") {
      taken.add(receipt.output.video_id);
    }
    if (typeof receipt.output.backup_id === "string") {
      taken.add(receipt.output.backup_id);
    }
  }
  if (ctx.pool !== null) {
    const pick = pickFromPool(ctx.pool, slot, taken);
    return {
      kind: "pick",
      slot,
      videoId: pick.videoId,
      backupId: pick.backupId,
      score: pick.score,
      reason: pick.reason,
    };
  }
  const candidates = ctx.config.backlog.filter(
    (entry) => entry.slot === slot && !taken.has(entry.video_id),
  );
  const video = candidates[0];
  if (video === undefined) {
    return {
      kind: "pick",
      slot,
      videoId: null,
      backupId: null,
      score: 0,
      reason: "no_candidates",
    };
  }
  return {
    kind: "pick",
    slot,
    videoId: video.video_id,
    backupId: candidates[1]?.video_id ?? null,
    score: candidates.length,
    reason: "backlog",
  };
}

export function transcriptForSlot(byNode: Map<string, Receipt>, slot: Slot): Plan {
  const pick = byNode.get(`pick-${slot}`);
  const videoId = pick?.output.video_id;
  if (
    pick === undefined ||
    pick.status !== "done" ||
    typeof videoId !== "string"
  ) {
    return { kind: "none" };
  }
  const receipt = byNode.get(`transcript-${slot}`);
  if (isTerminal(receipt)) return { kind: "none" };
  if (receipt === undefined) {
    return { kind: "transcript-job", slot, videoId, attempt: 1, isBackup: false };
  }
  if (receipt.status !== "failed") return { kind: "none" };
  // A failed try on the backup id ends the node: the slot stays empty.
  if (receipt.output.video_id !== videoId) return { kind: "none" };
  if (receipt.attempt >= TRANSCRIPT_MAX_PRIMARY_ATTEMPTS) {
    const backup = pick.output.backup_id;
    return typeof backup === "string"
      ? {
          kind: "transcript-job",
          slot,
          videoId: backup,
          attempt: receipt.attempt + 1,
          isBackup: true,
        }
      : { kind: "none" };
  }
  return {
    kind: "transcript-job",
    slot,
    videoId,
    attempt: receipt.attempt + 1,
    isBackup: false,
  };
}

/**
 * The reducer of RFC-001: given the record lines, the tick time and the
 * config, returns the next due node, or none. `pool` scans first, then
 * picks, then transcripts: picks are synchronous while transcript jobs
 * are asynchronous. `config` itself is handled by `planConfig` before
 * this.
 */
export function fold(lines: string[], now: Date, ctx: FoldCtx): Plan {
  if (!ctx.config.enabled) return { kind: "none" };
  const byNode = foldReceipts(lines);
  const date = taipeiDate(now);
  const nowMs = now.getTime();
  const pool = byNode.get("pool");
  if (!isTerminal(pool)) {
    return { kind: "pool", attempt: (pool?.attempt ?? 0) + 1 };
  }
  for (const slot of SLOTS) {
    if (byNode.has(`pick-${slot}`)) continue;
    if (nowMs < slotInstant(date, ctx.config.slots[slot - 1])) continue;
    return pickForSlot(lines, slot, ctx);
  }
  for (const slot of SLOTS) {
    const plan = transcriptForSlot(byNode, slot);
    if (plan.kind !== "none") return plan;
  }
  return { kind: "none" };
}

/**
 * The `config` node runs ahead of every other decision: its receipt fixes
 * the config sha, `enabled` and `mode` the night ran on. A missing or
 * unparseable file is escalated once; a fixed config next tick clears it
 * with a done receipt.
 */
export function planConfig(
  lines: string[],
  configResult:
    | { ok: true; config: PodcastConfig; configSha: string }
    | { ok: false; error: string },
): Plan | null {
  const receipt = foldReceipts(lines).get("config");
  if (!configResult.ok) {
    if (receipt?.status === "escalated") return null;
    return {
      kind: "config",
      status: "escalated",
      attempt: (receipt?.attempt ?? 0) + 1,
      error: configResult.error,
    };
  }
  if (receipt !== undefined && receipt.status !== "escalated") return null;
  return {
    kind: "config",
    status: "done",
    attempt: (receipt?.attempt ?? 0) + 1,
    configSha: configResult.configSha,
    enabled: configResult.config.enabled,
    mode: configResult.config.mode,
  };
}
