/**
 * The `pool` node's pure part (RFC-003):
 * one week-filtered search per topic query, a month-filtered second
 * search for a topic that found nothing, then the quality-bar filters
 * and the fixed score. `config.backlog` entries enter their slot
 * without the age filter. All fetches go through the injected
 * PageFetch so the seam is testable.
 */
import type { PodcastConfig } from "../config.js";
import type { PageEntry } from "./page.js";
import type { PageFetch, SearchFilter } from "./search.js";

/** The quality bar's duration band: 8 to 90 minutes, RFC-003. */
export const DURATION_BAND_SEC = { min: 8 * 60, max: 90 * 60 } as const;
/** The "two days or less" score point, in hours. */
export const FRESH_AGE_HOURS = 2 * 24;
/** A pool run gets one fill, then escalates (RFC-001). */
export const POOL_MAX_ATTEMPTS = 2;

export interface ScoreSignals {
  queries: number;
  fresh: number;
  cc: number;
  views: number;
  boost: number;
}

export interface PoolCandidate {
  id: string;
  slot: number;
  title: string | null;
  channel: string | null;
  durationSec: number | null;
  views: number | null;
  ageHours: number | null;
  cc: boolean;
  matchedQueries: string[];
  filter: SearchFilter | null;
  origin: "search" | "backlog";
  signals: ScoreSignals;
  score: number;
}

export interface SearchRecord {
  slot: number;
  query: string;
  filter: SearchFilter;
  status: "ok" | "error";
  entries: number;
  error: string | null;
}

export type PoolOutcome =
  | { ok: true; candidates: PoolCandidate[]; searches: SearchRecord[] }
  | { ok: false; error: string; searches: SearchRecord[] };

/** The fixed score of RFC-003: query matches, freshness, CC, views, channel boost. */
export function scoreEntry(
  entry: {
    matchedQueries: string[];
    ageHours: number | null;
    cc: boolean;
    views: number | null;
    channel: string | null;
  },
  config: PodcastConfig,
): { signals: ScoreSignals; score: number } {
  const signals: ScoreSignals = {
    queries: Math.min(entry.matchedQueries.length, 3),
    fresh: entry.ageHours !== null && entry.ageHours <= FRESH_AGE_HOURS ? 2 : 0,
    cc: entry.cc ? 1 : 0,
    views:
      entry.views !== null && entry.views > 0
        ? Math.min(Math.log10(entry.views) / 2, 3)
        : 0,
    boost:
      entry.channel !== null &&
      Object.prototype.hasOwnProperty.call(config.channel_boost, entry.channel)
        ? config.channel_boost[entry.channel]
        : 0,
  };
  return {
    signals,
    score:
      signals.queries +
      signals.fresh +
      signals.cc +
      signals.views +
      signals.boost,
  };
}

/**
 * Runs the searches and builds the candidate pool. A topic with zero
 * passing week candidates gets a month search for that topic only.
 * Any search error fails the run: the router retries it once, then
 * escalates, and picks fall back to the backlog (RFC-001).
 */
export async function collectPool(opts: {
  config: PodcastConfig;
  usedVideoIds: ReadonlySet<string>;
  fetch: PageFetch;
}): Promise<PoolOutcome> {
  const { config, usedVideoIds } = opts;
  const deny = new Set(config.deny_channels);
  const searches: SearchRecord[] = [];
  const byKey = new Map<string, PoolCandidate>();

  const passesBar = (entry: PageEntry): boolean =>
    !usedVideoIds.has(entry.id) &&
    entry.durationSec !== null &&
    entry.durationSec >= DURATION_BAND_SEC.min &&
    entry.durationSec <= DURATION_BAND_SEC.max &&
    (entry.channel === null || !deny.has(entry.channel));

  const merge = (entry: PageEntry, slot: number, query: string, filter: SearchFilter): void => {
    if (!passesBar(entry)) return;
    const key = `${slot}:${entry.id}`;
    const existing = byKey.get(key);
    if (existing !== undefined) {
      if (!existing.matchedQueries.includes(query)) existing.matchedQueries.push(query);
      return;
    }
    byKey.set(key, {
      id: entry.id,
      slot,
      title: entry.title,
      channel: entry.channel,
      durationSec: entry.durationSec,
      views: entry.views,
      ageHours: entry.ageHours,
      cc: entry.cc,
      matchedQueries: [query],
      filter,
      origin: "search",
      signals: { queries: 0, fresh: 0, cc: 0, views: 0, boost: 0 },
      score: 0,
    });
  };

  const runSearch = async (slot: number, query: string, filter: SearchFilter): Promise<number> => {
    const result = await opts.fetch(query, filter);
    if (!result.ok) {
      searches.push({ slot, query, filter, status: "error", entries: 0, error: result.error });
      return 0;
    }
    searches.push({ slot, query, filter, status: "ok", entries: result.entries.length, error: null });
    let added = 0;
    for (const entry of result.entries) {
      const before = byKey.size;
      merge(entry, slot, query, filter);
      if (byKey.size > before) added += 1;
    }
    return added;
  };

  const perTopic = new Map<number, number>();
  for (const topic of config.topics) {
    let added = 0;
    for (const query of topic.queries) {
      added += await runSearch(topic.slot, query, "week");
    }
    perTopic.set(topic.slot, added);
  }
  for (const topic of config.topics) {
    if ((perTopic.get(topic.slot) ?? 0) > 0) continue;
    for (const query of topic.queries) {
      await runSearch(topic.slot, query, "month");
    }
  }

  const failed = searches.filter((s) => s.status === "error");
  if (failed.length > 0) {
    return { ok: false, error: `search_failed:${failed[0].error}`, searches };
  }

  for (const entry of config.backlog) {
    if (usedVideoIds.has(entry.video_id)) continue;
    const key = `${entry.slot}:${entry.video_id}`;
    if (byKey.has(key)) continue;
    byKey.set(key, {
      id: entry.video_id,
      slot: entry.slot,
      title: null,
      channel: null,
      durationSec: null,
      views: null,
      ageHours: null,
      cc: false,
      matchedQueries: [],
      filter: null,
      origin: "backlog",
      signals: { queries: 0, fresh: 0, cc: 0, views: 0, boost: 0 },
      score: 0,
    });
  }

  const candidates = [...byKey.values()];
  for (const candidate of candidates) {
    if (candidate.origin === "search") {
      const { signals, score } = scoreEntry(candidate, config);
      candidate.signals = signals;
      candidate.score = score;
    }
  }
  candidates.sort((a, b) => compareCandidates(a, b) || a.slot - b.slot);
  return { ok: true, candidates, searches };
}

/**
 * Deterministic order for picks (RFC-003): highest score first;
 * ties by the smaller relative age, then by the smaller video id.
 * An unknown age sorts after every known age.
 */
export function compareCandidates(a: PoolCandidate, b: PoolCandidate): number {
  if (b.score !== a.score) return b.score - a.score;
  const ageA = a.ageHours ?? Number.POSITIVE_INFINITY;
  const ageB = b.ageHours ?? Number.POSITIVE_INFINITY;
  if (ageA !== ageB) return ageA - ageB;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
