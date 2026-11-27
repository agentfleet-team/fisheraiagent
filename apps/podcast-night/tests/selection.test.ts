import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { PodcastConfig } from "../src/config.js";
import type { GhStore } from "../src/github.js";
import { parseReceiptLine, type Receipt } from "../src/receipt.js";
import { parseResultsPage, type PageEntry } from "../src/selection/page.js";
import { pickFromPool } from "../src/selection/pick.js";
import { collectPool, scoreEntry, type PoolCandidate } from "../src/selection/pool.js";
import { unusedTail } from "./unused-tools.js";
import { fetchResultsPage, type PageFetch, type SearchFilter } from "../src/selection/search.js";
import type { PollResult, SubmitResult, Tool1, TranscriptDoc } from "../src/tool1.js";
import { runTick } from "../src/worker.js";

const APP_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURES = join(APP_DIR, "test", "fixtures");
const RUNS = "research/morning-podcast/runs";
const CONFIG_PATH = "research/morning-podcast/config.json";
const DATE = "2026-11-28";
const RECORD_PATH = `${RUNS}/${DATE}.jsonl`;

// 2026-11-28 00:00 Asia/Taipei == 2026-11-27T16:00:00Z.
const T = (hhmm: string) => new Date(`2026-11-27T${hhmm}:00Z`);

function entry(over: Partial<PageEntry> = {}): PageEntry {
  return {
    id: "vid-default1",
    title: "a video",
    channel: "Some Channel",
    durationSec: 1200,
    views: 5000,
    ageHours: 20,
    ageText: "20h ago",
    cc: false,
    ...over,
  };
}

function candidate(over: Partial<PoolCandidate> = {}): PoolCandidate {
  const c: PoolCandidate = {
    id: "vid-default1",
    slot: 1,
    title: "a video",
    channel: "Some Channel",
    durationSec: 1200,
    views: 5000,
    ageHours: 20,
    cc: false,
    matchedQueries: ["q"],
    filter: "week",
    origin: "search",
    signals: { queries: 1, fresh: 2, cc: 0, views: 1.85, boost: 0 },
    score: 4.85,
    ...over,
  };
  return c;
}

function config(over: Partial<PodcastConfig> = {}): PodcastConfig {
  return {
    enabled: true,
    mode: "trial",
    slots: ["00:00", "01:00", "02:00"],
    content_at: "03:00",
    topics: [
      { slot: 1, name: "Agent workflows", queries: ["t1q1", "t1q2"] },
      { slot: 2, name: "Practical cases", queries: ["t2q1"] },
      { slot: 3, name: "Memory and reliability", queries: ["t3q1"] },
    ],
    backlog: [],
    channel_boost: {},
    deny_channels: [],
    ...over,
  };
}

/** A PageFetch that serves canned entries per "<filter>:<query>" and records calls. */
function cannedFetch(pages: Record<string, PageEntry[] | { error: string }>) {
  const calls: string[] = [];
  const fetch: PageFetch = async (query: string, filter: SearchFilter) => {
    calls.push(`${filter}:${query}`);
    const page = pages[`${filter}:${query}`];
    if (page === undefined) return { ok: true, entries: [] };
    if ("error" in page) return { ok: false, error: page.error };
    return { ok: true, entries: page };
  };
  return { fetch, calls };
}

class FakeStore implements GhStore {
  files = new Map<string, { sha: string; text: string }>();
  private seq = 0;

  seed(path: string, text: string): void {
    this.files.set(path, { sha: `seed-${path}`, text });
  }

  async readFile(path: string) {
    const file = this.files.get(path);
    return file === undefined ? null : { sha: file.sha, text: file.text };
  }

  async writeFile(path: string, text: string, sha: string | null) {
    const current = this.files.get(path);
    if (sha === null && current !== undefined) return "conflict" as const;
    if (sha !== null && (current === undefined || current.sha !== sha)) {
      return "conflict" as const;
    }
    this.files.set(path, { sha: `sha-${this.seq++}`, text });
    return "ok" as const;
  }

  async listDir(path: string) {
    const prefix = `${path}/`;
    return [...this.files.keys()]
      .filter((key) => key.startsWith(prefix))
      .map((key) => key.slice(prefix.length))
      .filter((name) => !name.includes("/"));
  }

  recordReceipts(path = RECORD_PATH): Receipt[] {
    const file = this.files.get(path);
    if (file === undefined) return [];
    return file.text
      .split("\n")
      .map((line) => parseReceiptLine(line))
      .filter((r): r is Receipt => r !== null);
  }
}

class NoopTool implements Tool1 {
  submits: string[] = [];
  async submit(url: string): Promise<SubmitResult> {
    this.submits.push(url);
    return { kind: "job", jobId: "job-0" };
  }
  async poll(_jobId: string): Promise<PollResult> {
    const doc: TranscriptDoc = { video_id: "x", blocks: [] };
    return { kind: "done", result: doc };
  }
}

describe("selection: results-page parser (fisherivco/allen-ai-os#1901)", () => {
  it("S1: the videoRenderer fixture returns every video entry with id, title, channel, duration seconds, view count, age in hours and cc", () => {
    const result = parseResultsPage(
      readFileSync(join(FIXTURES, "results-renderer.html"), "utf8"),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // 4 video renderers; the adSlot/reelItem noise is skipped.
    expect(result.entries).toHaveLength(4);
    const byId = new Map(result.entries.map((e) => [e.id, e]));
    expect(byId.get("uClZwJ-BoSc")).toMatchObject({
      title: "Hermes Agent just leveled up...",
      channel: "Wes Roth",
      durationSec: 1804,
      views: 44925,
      ageHours: 14,
      ageText: "14h ago",
      cc: false,
    });
    expect(byId.get("4LINhsEZEDI")).toMatchObject({
      title: "4 Types of AI Agent Loops: From Human-Led to Autonomous",
      channel: "IBM Technology",
      durationSec: 548,
      views: 78424,
      ageHours: 168,
      cc: true,
    });
    // The A/B layout gap: no byline and no age text parse as null.
    expect(byId.get("wJcYhpX_fEQ")).toMatchObject({ channel: null });
    expect(byId.get("S55-4k6Lq5w")).toMatchObject({
      views: 1,
      ageHours: null,
      durationSec: 249,
    });
    for (const e of result.entries) {
      expect(e.id).toHaveLength(11);
      expect(typeof e.title).toBe("string");
      expect(typeof e.cc).toBe("boolean");
    }
  });

  it("S1: the lockupViewModel fixture returns video entries and skips non-video lockups", () => {
    const result = parseResultsPage(
      readFileSync(join(FIXTURES, "results-lockup.html"), "utf8"),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // 5 video lockups; the LOCKUP_CONTENT_TYPE_PLAYLIST entry is skipped.
    expect(result.entries).toHaveLength(5);
    const byId = new Map(result.entries.map((e) => [e.id, e]));
    expect(byId.get("l4sulk9jxGk")).toMatchObject({
      title: "【全民 AI 手冊】寫給一般人的 Claude 新手教學：30 分鐘完整功能解說，徹底改寫上班族的日常！",
      channel: "PAPAYA 電腦教室",
      durationSec: 1778,
      views: 24000,
      ageHours: 4,
      cc: true,
    });
    expect(byId.get("czLSxjHkstA")).toMatchObject({
      channel: "Microsoft Reactor 中文",
      durationSec: 3550,
      views: 7,
      ageHours: 24,
      cc: false,
    });
    expect(byId.get("KRQFmUEbbbA")).toMatchObject({
      channel: "KYC AI LABS",
      durationSec: 411,
      views: 67,
      ageHours: 168,
      cc: false,
    });
    expect(byId.get("2MrlhX9zjuo")).toMatchObject({
      channel: "SHOPLINE Taiwan",
      durationSec: 2843,
      views: 91,
      ageHours: 24,
      cc: true,
    });
    // Channel recovered from the avatar a11y label when the row lacks it.
    expect(byId.get("G0rPfNdmVdk")).toMatchObject({ channel: "島讀世界" });
  });

  it("S1: a page with no ytInitialData returns a typed error, not an empty list", () => {
    const result = parseResultsPage(
      readFileSync(join(FIXTURES, "no-initial-data.html"), "utf8"),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("no_yt_initial_data");
  });

  it("S1: videoRenderer falls back to shortViewCountText when viewCountText is absent", () => {
    const result = parseResultsPage(
      readFileSync(join(FIXTURES, "results-renderer.html"), "utf8"),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entries.find((e) => e.id === "S55-4k6Lq5w")?.views).toBe(1);
  });
});

describe("selection: pool filters and score (#1901)", () => {
  it("S2: a used video id, an out-of-band duration and a denied channel never enter the pool", async () => {
    const cfg = config({ deny_channels: ["Bad Channel"] });
    const pages = {
      "week:t1q1": [
        entry({ id: "used-video1" }), // in an earlier run record
        entry({ id: "short-video", durationSec: 300 }), // < 8 min
        entry({ id: "long-video0", durationSec: 6000 }), // > 90 min
        entry({ id: "denied-chan", channel: "Bad Channel" }),
        entry({ id: "good-video1" }),
      ],
    };
    const { fetch } = cannedFetch(pages);
    const outcome = await collectPool({
      config: cfg,
      usedVideoIds: new Set(["used-video1"]),
      fetch,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const ids = outcome.candidates.map((c) => c.id);
    expect(ids).toEqual(["good-video1"]);
  });

  it("S3: a topic with zero week candidates triggers one month search for that topic only", async () => {
    const { fetch, calls } = cannedFetch({
      "week:t1q1": [entry({ id: "t1-video-1" })],
      "week:t3q1": [entry({ id: "t3-video-1" })],
      "month:t2q1": [entry({ id: "t2-month-1" })],
    });
    const outcome = await collectPool({
      config: config(),
      usedVideoIds: new Set(),
      fetch,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    // Week searches for every query of every topic.
    expect(calls.filter((c) => c.startsWith("week:"))).toEqual([
      "week:t1q1",
      "week:t1q2",
      "week:t2q1",
      "week:t3q1",
    ]);
    // Month searches only for the empty topic's queries.
    expect(calls.filter((c) => c.startsWith("month:"))).toEqual(["month:t2q1"]);
    const month = outcome.candidates.find((c) => c.id === "t2-month-1");
    expect(month?.slot).toBe(2);
    expect(month?.filter).toBe("month");
  });

  it("S4: the same pool always gives the same picks — score, then smaller age, then smaller id", () => {
    const rows: [string, PoolCandidate[], { pick: string | null; backup: string | null }][] = [
      [
        "highest score wins, second is the backup",
        [
          candidate({ id: "video-low01", score: 2 }),
          candidate({ id: "video-high1", score: 6 }),
          candidate({ id: "video-mid01", score: 4 }),
        ],
        { pick: "video-high1", backup: "video-mid01" },
      ],
      [
        "equal scores: the smaller age wins",
        [
          candidate({ id: "video-old001", score: 4, ageHours: 100 }),
          candidate({ id: "video-new001", score: 4, ageHours: 10 }),
        ],
        { pick: "video-new001", backup: "video-old001" },
      ],
      [
        "equal scores and ages: the smaller id wins",
        [
          candidate({ id: "video-zzzzz", score: 4, ageHours: 10 }),
          candidate({ id: "video-aaaaa", score: 4, ageHours: 10 }),
        ],
        { pick: "video-aaaaa", backup: "video-zzzzz" },
      ],
      [
        "an unknown age sorts after a known age on a tie",
        [
          candidate({ id: "video-unknw1", score: 4, ageHours: null }),
          candidate({ id: "video-known", score: 4, ageHours: 10 }),
        ],
        { pick: "video-known", backup: "video-unknw1" },
      ],
    ];
    for (const [name, pool, want] of rows) {
      for (let i = 0; i < 2; i += 1) {
        const pick = pickFromPool(pool, 1, new Set());
        expect(pick.videoId, `${name} run ${i}`).toBe(want.pick);
        expect(pick.backupId, `${name} run ${i}`).toBe(want.backup);
      }
    }
    // An earlier pick's id is taken for the next slot decision.
    const second = pickFromPool(rows[0][1], 1, new Set(["video-high1"]));
    expect(second.videoId).toBe("video-mid01");
    // A slot with no candidates is empty, with the RFC-003 reason.
    const empty = pickFromPool(rows[0][1], 2, new Set());
    expect(empty.videoId).toBeNull();
    expect(empty.reason).toBe("no_candidates");
  });

  it("S4: the fixed score sums query cap, inclusive freshness, CC, capped views and channel boost", () => {
    expect(
      scoreEntry(
        {
          matchedQueries: ["a", "b", "c", "d"],
          ageHours: 48,
          cc: true,
          views: 1e8,
          channel: "Boosted",
        },
        config({ channel_boost: { Boosted: -2 } }),
      ),
    ).toEqual({
      signals: { queries: 3, fresh: 2, cc: 1, views: 3, boost: -2 },
      score: 7,
    });
    expect(
      scoreEntry(
        {
          matchedQueries: ["a"],
          ageHours: 49,
          cc: false,
          views: 1000,
          channel: "Unlisted",
        },
        config(),
      ).score,
    ).toBe(2.5);
  });

  it("S4: an unconfigured channel named constructor receives zero boost", () => {
    expect(
      scoreEntry(
        {
          matchedQueries: ["a"],
          ageHours: 49,
          cc: false,
          views: 1000,
          channel: "constructor",
        },
        config(),
      ).score,
    ).toBe(2.5);
  });

  it("S4: a bare backlog video scores 0 — the CC point comes only from the badge signal", async () => {
    const cfg = config({
      topics: [{ slot: 1, name: "test", queries: ["q"] }],
      backlog: [{ video_id: "aaaaaaaaaaa", slot: 1 }],
    });
    const { fetch } = cannedFetch({
      "week:q": [entry({ id: "zzzzzzzzzzz", ageHours: null, views: 0 })],
    });
    const outcome = await collectPool({
      config: cfg,
      usedVideoIds: new Set(),
      fetch,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(
      outcome.candidates.find((c) => c.id === "aaaaaaaaaaa")?.score,
    ).toBe(0);
    expect(pickFromPool(outcome.candidates, 1, new Set()).videoId).toBe(
      "zzzzzzzzzzz",
    );
  });

  it("S3: the search call only ever GETs the RFC-003 results URL", async () => {
    const allowed = new Set([
      "https://www.youtube.com/results?search_query=AI%20agent&sp=CAISBAgDEAE%3D",
      "https://www.youtube.com/results?search_query=AI%20agent&sp=CAISBAgEEAE%3D",
    ]);
    const stub = async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      if (request.method !== "GET" || !allowed.has(request.url)) {
        return new Response(null, { status: 400 });
      }
      return new Response("<script>var ytInitialData = {};</script>");
    };
    vi.stubGlobal("fetch", stub);
    try {
      expect((await stub([...allowed][0], { method: "POST" })).status).toBe(400);
      expect(
        (await stub("https://www.youtube.com/youtubei/v1/player")).status,
      ).toBe(400);
      expect(
        (await stub([...allowed][0].replace("%3D", "%253D"))).status,
      ).toBe(400);
      expect((await fetchResultsPage("AI agent", "week")).ok).toBe(true);
      expect((await fetchResultsPage("AI agent", "month")).ok).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("S5: backlog entries enter their slot without the age filter", async () => {
    const cfg = config({
      backlog: [
        { video_id: "yts-saved-01", slot: 2 },
        { video_id: "yts-saved-02", slot: 3 },
      ],
    });
    const { fetch } = cannedFetch({ "week:t1q1": [entry({ id: "fresh-one-1" })] });
    const outcome = await collectPool({
      config: cfg,
      usedVideoIds: new Set(),
      fetch,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const saved = outcome.candidates.find((c) => c.id === "yts-saved-01");
    expect(saved).toBeDefined();
    expect(saved?.origin).toBe("backlog");
    expect(saved?.slot).toBe(2);
    expect(saved?.ageHours).toBeNull();
    // A backlog id already used by an earlier run never enters the pool.
    const again = await collectPool({
      config: cfg,
      usedVideoIds: new Set(["yts-saved-01"]),
      fetch,
    });
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.candidates.some((c) => c.id === "yts-saved-01")).toBe(false);
    expect(again.candidates.some((c) => c.id === "yts-saved-02")).toBe(true);
  });
});

describe("selection: pool node in the router (#1901)", () => {
  const TEST_ENV = {
    STATE_REPO: "fisherivco/allen-state",
    SUMMARY_REPO: "fisherivco/allen-ai-os",
    SUMMARY_ISSUE: "1878",
  };

  function configJson(overrides: Record<string, unknown> = {}): string {
    const cfg = config({
      backlog: [{ video_id: "jVBlkOF8sHk", slot: 1 }],
    });
    return JSON.stringify({ ...cfg, ...overrides });
  }

  it("a tick at 00:00 runs config, pool and pick-1; the pick comes from the scored pool", async () => {
    const store = new FakeStore();
    store.seed(CONFIG_PATH, configJson());
    const tool = new NoopTool();
    const { fetch, calls } = cannedFetch({
      "week:t1q1": [
        entry({ id: "best-video1", views: 9000, ageHours: 10, cc: true }),
      ],
      "week:t1q2": [entry({ id: "best-video1", views: 9000, ageHours: 10, cc: true })],
    });
    const tick = await runTick({
      store,
      tool1: tool,
      ...unusedTail,
      env: TEST_ENV,
      now: T("16:00"),
      dryRun: false,
      by: "podcast-night@0.1.0",
      search: fetch,
    });
    const nodes = tick.appended.map((r) => r.node);
    expect(nodes).toEqual(["config", "pool", "pick-1", "transcript-1"]);
    const pool = tick.appended[1];
    expect(pool.status).toBe("done");
    expect(pool.output.count).toBe(2);
    expect(pool.output.source).toBe("worker");
    expect(typeof pool.output.pool_sha256).toBe("string");
    // best-video1 matched both queries of slot 1 -> score beats backlog.
    expect(tick.appended[2].output.video_id).toBe("best-video1");
    expect(tick.appended[2].output.backup_id).toBe("jVBlkOF8sHk");
    expect(tool.submits).toEqual(["https://www.youtube.com/watch?v=best-video1"]);
    // pool.json committed next to the record with the candidate list.
    const file = store.files.get(`${RUNS}/${DATE}/pool.json`);
    expect(file?.text).toContain("best-video1");
    expect(file?.text).toContain("jVBlkOF8sHk");
    // Slots 2 and 3 had no week hits, so each got its month search.
    expect(calls.filter((c) => c.startsWith("month:"))).toEqual([
      "month:t2q1",
      "month:t3q1",
    ]);
  });

  it("S2: a superseded receipt line in an earlier record still reserves its video id", async () => {
    const store = new FakeStore();
    store.seed(CONFIG_PATH, configJson());
    const history = (id: string, attempt: number, status: string) =>
      JSON.stringify({
        v: 1,
        date: "2026-11-27",
        node: "transcript-1",
        key: "2026-11-27/transcript-1",
        status,
        attempt,
        input_sha256: "a".repeat(64),
        output: { video_id: id },
        error: status === "failed" ? "failed" : null,
        at: "2026-11-26T16:00:00Z",
        by: "test",
      });
    // Attempt 1 failed on old-video01; attempt 2 filled new-video01.
    // The fold keeps only attempt 2, but old-video01 was already
    // consumed, so the pool must exclude both.
    store.seed(
      `${RUNS}/2026-11-27.jsonl`,
      `${history("old-video01", 1, "failed")}\n${history("new-video01", 2, "filled")}\n`,
    );
    const { fetch } = cannedFetch({
      "week:t1q1": [entry({ id: "old-video01" }), entry({ id: "new-video01" })],
    });
    await runTick({
      store,
      tool1: new NoopTool(),
      ...unusedTail,
      env: TEST_ENV,
      now: T("16:00"),
      dryRun: false,
      search: fetch,
    });
    const pool = store.files.get(`${RUNS}/${DATE}/pool.json`);
    expect(pool).toBeDefined();
    const ids = (JSON.parse(pool!.text).candidates as PoolCandidate[]).map(
      (c) => c.id,
    );
    expect(ids).not.toContain("old-video01");
    expect(ids).not.toContain("new-video01");
  });

  it("a failed pool run retries once, then escalates, and picks fall back to the backlog", async () => {
    const store = new FakeStore();
    store.seed(CONFIG_PATH, configJson());
    const tool = new NoopTool();
    const { fetch } = cannedFetch({ "week:t1q1": { error: "http_429" } });
    // One search error fails the run. Like a transcript node the pool
    // retries inside the same tick; the second failure escalates and
    // pick-1 falls back to the config backlog (RFC-001).
    const tick = await runTick({
      store, tool1: tool, ...unusedTail, env: TEST_ENV, now: T("16:00"), dryRun: false, search: fetch,
    });
    const appended = tick.appended.map((r) => [r.node, r.status, r.attempt]);
    expect(appended).toEqual([
      ["config", "done", 1],
      ["pool", "failed", 1],
      ["pool", "escalated", 2],
      ["pick-1", "done", 1],
      ["transcript-1", "done", 1],
    ]);
    const pick = tick.appended.find((r) => r.node === "pick-1");
    expect(pick?.output.video_id).toBe("jVBlkOF8sHk");
    expect(pick?.output.reason).toBe("backlog");
  });
});
