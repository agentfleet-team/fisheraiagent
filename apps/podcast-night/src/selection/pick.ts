/**
 * The `pick-<n>` node's decision on the pool (RFC-003): the highest
 * score in the slot is the pick, the second is the backup (PRD story
 * 23). Ids in `taken` (earlier nights and earlier picks tonight) are
 * skipped. The sort is total, so a re-run picks the same video.
 */
import { compareCandidates, type PoolCandidate } from "./pool.js";

export interface SlotPick {
  videoId: string | null;
  backupId: string | null;
  score: number;
  reason: string;
}

function pickReason(c: PoolCandidate): string {
  if (c.origin === "backlog") return "backlog";
  const s = c.signals;
  const parts = [
    `q=${s.queries}`,
    s.fresh > 0 ? "fresh" : null,
    s.cc > 0 ? "cc" : null,
    c.views !== null ? `views=${c.views}` : "views=?",
    s.boost !== 0 ? `boost=${s.boost}` : null,
  ];
  return parts.filter((p): p is string => p !== null).join(" ").slice(0, 200);
}

export function pickFromPool(
  candidates: PoolCandidate[],
  slot: number,
  taken: ReadonlySet<string>,
): SlotPick {
  const sorted = candidates
    .filter((c) => c.slot === slot && !taken.has(c.id))
    .sort(compareCandidates);
  const first = sorted[0];
  if (first === undefined) {
    return { videoId: null, backupId: null, score: 0, reason: "no_candidates" };
  }
  return {
    videoId: first.id,
    backupId: sorted[1]?.id ?? null,
    score: first.score,
    reason: pickReason(first),
  };
}
