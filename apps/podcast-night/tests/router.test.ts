import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { GhStore } from "../src/github.js";
import { parseReceiptLine, type Receipt } from "../src/receipt.js";
import type { PollResult, SubmitResult, Tool1, TranscriptDoc } from "../src/tool1.js";
import { runTick, type TickOutcome } from "../src/worker.js";
import { unusedTail } from "./unused-tools.js";

const APP_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const RUNS = "research/morning-podcast/runs";
const CONFIG_PATH = "research/morning-podcast/config.json";
const DATE = "2026-11-28";
const RECORD_PATH = `${RUNS}/${DATE}.jsonl`;

// 2026-11-28 00:00 Asia/Taipei == 2026-11-27T16:00:00Z.
const T = (hhmm: string) => new Date(`2026-11-27T${hhmm}:00Z`);

const V1 = "jVBlkOF8sHk";
const V2 = "hWe-j78vNpc";
const V3 = "37ROC7uPieE";
const V4 = "eKhog2ZXlQg";
const V5 = "r0Mm_79yKso";
const V6 = "DGI4vucR71w";

function configJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    enabled: true,
    mode: "trial",
    slots: ["00:00", "01:00", "02:00"],
    content_at: "03:00",
    topics: [
      { slot: 1, name: "Agent workflows", queries: ["q1"] },
      { slot: 2, name: "Practical cases", queries: ["q2"] },
      { slot: 3, name: "Memory and reliability", queries: ["q3"] },
    ],
    backlog: [
      { video_id: V1, slot: 1 },
      { video_id: V2, slot: 1 },
      { video_id: V3, slot: 2 },
      { video_id: V4, slot: 2 },
      { video_id: V5, slot: 3 },
      { video_id: V6, slot: 1 },
    ],
    ...overrides,
  });
}

function receipt(
  node: string,
  status: string,
  output: Record<string, unknown>,
  attempt = 1,
): string {
  return JSON.stringify({
    v: 1,
    date: DATE,
    node,
    key: `${DATE}/${node}`,
    status,
    attempt,
    input_sha256: "a".repeat(64),
    output,
    error: status === "done" || status === "filled" ? null : "err",
    at: "2026-11-27T16:00:00.000Z",
    by: "podcast-night@0.1.0",
  });
}

function transcriptDoc(videoId: string, source = "gemini"): TranscriptDoc {
  return {
    video_id: videoId,
    source_url: `https://www.youtube.com/watch?v=${videoId}`,
    language: "en",
    source: source as TranscriptDoc["source"],
    blocks: [
      { start: 0, end: 4.5, text: "TRANSCRIPT TEXT MARKER aaa" },
      { start: 4.5, end: 9, text: "TRANSCRIPT TEXT MARKER bbb" },
    ],
  };
}

class FakeStore implements GhStore {
  files = new Map<string, { sha: string; text: string }>();
  writes: { path: string; sha: string | null }[] = [];
  reads = 0;
  private seq = 0;
  private conflicts = new Map<string, number>();
  private conflictLine: string | null = null;

  seed(path: string, text: string): void {
    this.files.set(path, { sha: `seed-${path}`, text });
  }

  /** The next `count` writes to path get a 409; each simulates a competing writer appending a foreign line. */
  conflict(path: string, count: number, foreignLine?: string): void {
    this.conflicts.set(path, count);
    this.conflictLine =
      foreignLine ?? receipt("watch", "done", { reason: "other_writer" });
  }

  async readFile(path: string) {
    this.reads += 1;
    const file = this.files.get(path);
    return file === undefined ? null : { sha: file.sha, text: file.text };
  }

  async writeFile(path: string, text: string, sha: string | null) {
    this.writes.push({ path, sha });
    const current = this.files.get(path);
    const injected = this.conflicts.get(path) ?? 0;
    if (injected > 0) {
      this.conflicts.set(path, injected - 1);
      this.files.set(path, {
        sha: `other-${this.seq++}`,
        text: (current?.text ?? "") + (this.conflictLine ?? "") + "\n",
      });
      return "conflict";
    }
    if (sha === null && current !== undefined) return "conflict";
    if (sha !== null && (current === undefined || current.sha !== sha)) {
      return "conflict";
    }
    this.files.set(path, { sha: `sha-${this.seq++}`, text });
    return "ok";
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

interface FakeJob {
  views: PollResult[];
}

class FakeTool implements Tool1 {
  submits: string[] = [];
  polls = 0;
  private jobs = new Map<string, FakeJob>();
  private seq = 0;

  constructor(private plan: (url: string) => FakeJob | SubmitResult) {}

  async submit(url: string): Promise<SubmitResult> {
    this.submits.push(url);
    const planned = this.plan(url);
    if ("kind" in planned) return planned;
    const jobId = `job-${this.seq++}`;
    this.jobs.set(jobId, planned);
    return { kind: "job", jobId };
  }

  async poll(jobId: string): Promise<PollResult> {
    this.polls += 1;
    const job = this.jobs.get(jobId);
    if (job === undefined) return { kind: "not_found" };
    if (job.views.length > 1) return job.views.shift() as PollResult;
    return job.views[0];
  }
}

function done(doc: TranscriptDoc): FakeJob {
  return { views: [{ kind: "done", result: doc }] };
}
function running(): FakeJob {
  return { views: [{ kind: "running" }] };
}
function failed(code = "upstream_error"): FakeJob {
  return { views: [{ kind: "failed", error: code }] };
}

const TEST_ENV = {
  STATE_REPO: "fisherivco/allen-state",
  SUMMARY_REPO: "fisherivco/allen-ai-os",
  SUMMARY_ISSUE: "1878",
};

function makeDeps(
  store: FakeStore,
  tool: FakeTool,
  now: Date,
): Parameters<typeof runTick>[0] {
  return {
    store,
    tool1: tool,
    ...unusedTail,
    env: TEST_ENV,
    now,
    dryRun: false,
    by: "podcast-night@0.1.0",
    // A stub results page: no search hits, so the pool holds backlog only.
    search: async () => ({ ok: true as const, entries: [] }),
  };
}

describe("podcast-night router ticks (fisherivco/allen-ai-os#1900)", () => {
  it("A1: an empty record at 00:00 Taipei appends config then pick-1 then submits transcript-1; the next tick finishes it", async () => {
    const store = new FakeStore();
    store.seed(CONFIG_PATH, configJson());
    // With an empty results page the pool holds only backlog candidates;
    // they tie on score and the smallest id wins (RFC-003): V6 then V2.
    const tool = new FakeTool((url) =>
      url.endsWith(V6) ? running() : done(transcriptDoc(url.slice(-11))),
    );
    const tick1 = await runTick(makeDeps(store, tool, T("16:00")));
    const nodes = tick1.appended.map((r) => r.node);
    expect(nodes).toEqual(["config", "pool", "pick-1"]);
    expect(tick1.appended[0].status).toBe("done");
    expect(tick1.appended[0].output.enabled).toBe(true);
    expect(tick1.appended[0].output.mode).toBe("trial");
    expect(tick1.appended[1].status).toBe("done");
    expect(tick1.appended[1].output.source).toBe("worker");
    expect(tick1.appended[2].output.video_id).toBe(V6);
    expect(tick1.appended[2].output.backup_id).toBe(V2);
    expect(tool.submits).toEqual([`https://www.youtube.com/watch?v=${V6}`]);

    (tool as unknown as { plan: (url: string) => FakeJob }).plan = (url) =>
      done(transcriptDoc(url.slice(-11)));
    const tick2 = await runTick(makeDeps(store, tool, T("16:05")));
    expect(tick2.appended.map((r) => r.node)).toEqual(["transcript-1"]);
    expect(tick2.appended[0].status).toBe("done");
    const file = store.files.get(`${RUNS}/${DATE}/transcript-1.json`);
    expect(file?.text).toContain(V6);
    expect(store.recordReceipts().map((r) => r.node)).toEqual([
      "config",
      "pool",
      "pick-1",
      "transcript-1",
    ]);
  });

  it("A2: enabled:false appends only the config receipt and calls no tool", async () => {
    const store = new FakeStore();
    store.seed(CONFIG_PATH, configJson({ enabled: false }));
    const tool = new FakeTool(() => done(transcriptDoc(V1)));
    const tick1 = await runTick(makeDeps(store, tool, T("16:00")));
    expect(tick1.appended.map((r) => r.node)).toEqual(["config"]);
    expect(tick1.appended[0].output.enabled).toBe(false);
    const tick2 = await runTick(makeDeps(store, tool, T("16:05")));
    expect(tick2.appended).toEqual([]);
    expect(tool.submits).toEqual([]);
    expect(store.recordReceipts()).toHaveLength(1);
  });

  it("A3: a re-run of a finished night makes zero tool calls and zero writes", async () => {
    const store = new FakeStore();
    store.seed(CONFIG_PATH, configJson());
    store.seed(
      RECORD_PATH,
      [
        receipt("config", "done", { enabled: true, mode: "trial" }),
        receipt("pool", "done", { count: 6, source: "worker" }),
        receipt("pick-1", "done", { video_id: V1, backup_id: V2 }),
        receipt("pick-2", "done", { video_id: V3, backup_id: V4 }),
        receipt("pick-3", "done", { video_id: V5, backup_id: null }),
        receipt("transcript-1", "done", { video_id: V1, source: "gemini" }),
        receipt("transcript-2", "done", { video_id: V3, source: "gemini" }),
        receipt("transcript-3", "done", { video_id: V5, source: "captions:manual" }),
        receipt("content", "done", { chars: 2600, file_id: "f1" }),
        receipt("voice", "done", { duration_s: 595, audio_file_id: "f2", marks_file_id: "f3" }),
        receipt("check", "done", { chars: 2600, duration_s: 595 }),
        receipt("deliver", "done", {}),
        receipt("summary", "done", {}),
      ].join("\n") + "\n",
    );
    const tool = new FakeTool(() => done(transcriptDoc(V1)));
    const writesBefore = store.writes.length;
    const tick = await runTick(makeDeps(store, tool, T("20:00")));
    expect(tick.appended).toEqual([]);
    expect(tool.submits).toEqual([]);
    expect(store.writes.length).toBe(writesBefore);
  });

  it("A4: one 409 on append re-reads and appends once; a second 409 ends the tick with no write", async () => {
    const store = new FakeStore();
    store.seed(CONFIG_PATH, configJson());
    store.seed(
      RECORD_PATH,
      [
        receipt("config", "done", { enabled: true }),
        receipt("pool", "done", { count: 6, source: "worker" }),
      ].join("\n") + "\n",
    );
    const tool = new FakeTool(() => done(transcriptDoc(V1)));
    store.conflict(RECORD_PATH, 1);
    const tick = await runTick(makeDeps(store, tool, T("16:00")));
    expect(tick.appended.map((r) => r.node)).toEqual(["pick-1", "transcript-1"]);
    const lines = store.files.get(RECORD_PATH)?.text.trim().split("\n") ?? [];
    expect(lines.filter((l) => l.includes('"pick-1"'))).toHaveLength(1);
    // config + pool + foreign line + pick-1 + transcript-1
    expect(lines).toHaveLength(5);

    const store2 = new FakeStore();
    store2.seed(CONFIG_PATH, configJson());
    store2.seed(
      RECORD_PATH,
      [
        receipt("config", "done", { enabled: true }),
        receipt("pool", "done", { count: 6, source: "worker" }),
      ].join("\n") + "\n",
    );
    store2.conflict(RECORD_PATH, 2);
    const tick2 = await runTick(makeDeps(store2, tool, T("16:00")));
    expect(tick2.appended).toEqual([]);
    expect(
      store2.files.get(RECORD_PATH)?.text.includes('"pick-1"'),
    ).toBe(false);
  });

  it("A4: a 409 caused by a foreign line on a retry attempt re-reads and appends attempt 2 once", async () => {
    const store = new FakeStore();
    store.seed(CONFIG_PATH, configJson());
    store.seed(
      RECORD_PATH,
      [
        receipt("config", "done", { enabled: true }),
        receipt("pool", "done", { count: 6, source: "worker" }),
        receipt("pick-1", "done", { video_id: V1, backup_id: V2 }),
        receipt("transcript-1", "failed", { video_id: V1 }, 1),
      ].join("\n") + "\n",
    );
    const tool = new FakeTool(() => done(transcriptDoc(V1)));
    store.conflict(RECORD_PATH, 1);
    const tick = await runTick(makeDeps(store, tool, T("16:05")));
    expect(tick.appended.map((r) => [r.node, r.status, r.attempt])).toEqual([
      ["transcript-1", "done", 2],
    ]);
    const lines = store.files.get(RECORD_PATH)?.text.trim().split("\n") ?? [];
    expect(lines.filter((l) => l.includes('"transcript-1"') && l.includes('"attempt":2'))).toHaveLength(1);
  });

  it("A5: two failures on the pick fill with the backup id (filled); at most two attempts on it", async () => {
    const store = new FakeStore();
    store.seed(CONFIG_PATH, configJson());
    store.seed(
      RECORD_PATH,
      [
        receipt("config", "done", { enabled: true }),
        receipt("pool", "done", { count: 6, source: "worker" }),
        receipt("pick-1", "done", { video_id: V1, backup_id: V2 }),
      ].join("\n") + "\n",
    );
    const urls: string[] = [];
    const tool = new FakeTool((url) => {
      urls.push(url);
      if (url.endsWith(V1)) return failed();
      return done(transcriptDoc(url.slice(-11)));
    });
    const tick = await runTick(makeDeps(store, tool, T("16:05")));
    const t1 = tick.appended.filter((r) => r.node === "transcript-1");
    expect(t1.map((r) => r.status)).toEqual(["failed", "failed", "filled"]);
    expect(t1.map((r) => r.attempt)).toEqual([1, 2, 3]);
    expect(t1[2].output.video_id).toBe(V2);
    const primary = urls.filter((u) => u.endsWith(V1));
    expect(primary.length).toBeLessThanOrEqual(2);
    expect(urls[urls.length - 1].endsWith(V2)).toBe(true);
  });

  it("A5b: a poll 404 after a tool restart resubmits the same video id once", async () => {
    const store = new FakeStore();
    store.seed(CONFIG_PATH, configJson());
    store.seed(
      RECORD_PATH,
      [
        receipt("config", "done", { enabled: true }),
        receipt("pool", "done", { count: 6, source: "worker" }),
        receipt("pick-1", "done", { video_id: V1, backup_id: V2 }),
      ].join("\n") + "\n",
    );
    const tool = new FakeTool((url) => done(transcriptDoc(url.slice(-11))));
    const realSubmit = tool.submit.bind(tool);
    let first = true;
    tool.submit = async (url: string) => {
      const res = await realSubmit(url);
      if (first && res.kind === "job") {
        first = false;
        // Simulate a restart between submit and poll: the job id is gone.
        (tool as unknown as { jobs: Map<string, unknown> }).jobs.clear();
      }
      return res;
    };
    const tick = await runTick(makeDeps(store, tool, T("16:05")));
    expect(tick.appended.map((r) => r.node)).toEqual(["transcript-1"]);
    expect(tool.submits).toEqual([
      `https://www.youtube.com/watch?v=${V1}`,
      `https://www.youtube.com/watch?v=${V1}`,
    ]);
  });

  it("A6: a crash after submit and before the receipt: the next tick resubmits the same video id once; a third tick does nothing", async () => {
    const store = new FakeStore();
    store.seed(CONFIG_PATH, configJson());
    store.seed(
      RECORD_PATH,
      [
        receipt("config", "done", { enabled: true }),
        receipt("pool", "done", { count: 6, source: "worker" }),
        receipt("pick-1", "done", { video_id: V1, backup_id: V2 }),
      ].join("\n") + "\n",
    );
    const tool = new FakeTool((url) => done(transcriptDoc(url.slice(-11))));
    const url = `https://www.youtube.com/watch?v=${V1}`;

    const transcriptFile = `${RUNS}/${DATE}/transcript-1.json`;
    const realWrite = store.writeFile.bind(store);
    const thrown: string[] = [];
    let crashOn = true;

    // Tick 1: only a write to the record throws (the Worker dies after
    // tool1.submit and the transcript file, before the receipt).
    store.writeFile = async (path: string, text: string, sha: string | null) => {
      if (crashOn && path === RECORD_PATH) {
        thrown.push(path);
        throw new Error("simulated crash");
      }
      return realWrite(path, text, sha);
    };
    await expect(runTick(makeDeps(store, tool, T("16:05")))).rejects.toThrow(
      "simulated crash",
    );
    expect(thrown).toEqual([RECORD_PATH]);
    expect(tool.submits).toEqual([url]);
    expect(store.files.has(transcriptFile)).toBe(true);
    expect(store.recordReceipts().some((r) => r.node === "transcript-1")).toBe(false);

    // Tick 2: the record write works again; same video id submitted once more.
    crashOn = false;
    const writesBefore2 = store.writes.length;
    const tick2 = await runTick(makeDeps(store, tool, T("16:10")));
    expect(tool.submits).toEqual([url, url]);
    expect(tick2.appended.map((r) => [r.node, r.status])).toEqual([
      ["transcript-1", "done"],
    ]);
    expect(
      store.recordReceipts().filter((r) => r.node === "transcript-1"),
    ).toHaveLength(1);
    expect(
      store.writes.slice(writesBefore2).filter((w) => w.path === transcriptFile),
    ).toHaveLength(0);

    // Tick 3: zero submits and zero writes.
    const writesBefore = store.writes.length;
    const tick3 = await runTick(makeDeps(store, tool, T("16:15")));
    expect(tool.submits).toEqual([url, url]);
    expect(tick3.appended.filter((r) => r.node === "transcript-1")).toEqual([]);
    expect(store.writes.length).toBe(writesBefore);
  });

  it("A7: transcript-<n> always calls tool 1 and the receipt copies Transcript.source", async () => {
    for (const source of ["captions:manual", "captions:auto", "gemini"] as const) {
      const store = new FakeStore();
      store.seed(CONFIG_PATH, configJson());
      store.seed(
        RECORD_PATH,
        [
          receipt("config", "done", { enabled: true }),
          receipt("pool", "done", { count: 6, source: "worker" }),
          receipt("pick-1", "done", { video_id: V1, backup_id: V2 }),
        ].join("\n") + "\n",
      );
      const tool = new FakeTool(() => done(transcriptDoc(V1, source)));
      const tick = await runTick(makeDeps(store, tool, T("16:05")));
      expect(tool.submits).toEqual([`https://www.youtube.com/watch?v=${V1}`]);
      expect(tick.appended[0].output.source).toBe(source);
      expect(tick.appended[0].status).toBe("done");
    }
  });

  it("pick excludes video ids used by earlier nights' records", async () => {
    const store = new FakeStore();
    store.seed(CONFIG_PATH, configJson());
    const prior = JSON.stringify({
      v: 1,
      date: "2026-11-27",
      node: "pick-1",
      key: "2026-11-27/pick-1",
      status: "done",
      attempt: 1,
      input_sha256: null,
      output: { video_id: V1, backup_id: V6 },
      error: null,
      at: "2026-11-26T16:00:00.000Z",
      by: "podcast-night@0.1.0",
    });
    store.seed(`${RUNS}/2026-11-27.jsonl`, prior + "\n");
    const tool = new FakeTool(() => done(transcriptDoc(V2)));
    const tick = await runTick(makeDeps(store, tool, T("16:00")));
    const pick = tick.appended.find((r) => r.node === "pick-1");
    expect(pick?.output.video_id).toBe(V2);
    expect(pick?.output.backup_id).toBeNull();
  });

  it("a slot with no backlog candidates writes a pick receipt with no video and the transcript node stays empty", async () => {
    const store = new FakeStore();
    store.seed(CONFIG_PATH, configJson({ backlog: [] }));
    const tool = new FakeTool(() => done(transcriptDoc(V1)));
    const tick = await runTick(makeDeps(store, tool, T("16:00")));
    const nodes = tick.appended.map((r) => r.node);
    expect(nodes).toEqual(["config", "pool", "pick-1"]);
    expect(tick.appended[2].output.video_id).toBeNull();
    expect(tick.appended[2].output.reason).toBe("no_candidates");
    expect(tool.submits).toEqual([]);
  });
});

describe("fixture sanity", () => {
  it("the shipped config fixture parses", () => {
    const fixture = JSON.parse(
      readFileSync(join(APP_DIR, "fixtures/config.json"), "utf8"),
    );
    expect(fixture.enabled).toBe(true);
    expect(fixture.backlog.length).toBeGreaterThanOrEqual(3);
  });

  it("the worker ticks without GitHub or tool credentials as a dry run", async () => {
    const store = new FakeStore();
    store.seed(CONFIG_PATH, configJson());
    const tool = new FakeTool(() => done(transcriptDoc(V1)));
    const outcome: TickOutcome = await runTick({
      store,
      tool1: tool,
      ...unusedTail,
      env: TEST_ENV,
      now: T("16:00"),
      dryRun: true,
    });
    expect(outcome.appended).toEqual([]);
    expect(tool.submits).toEqual([]);
    expect(store.writes).toEqual([]);
    expect(outcome.lines.join("\n")).toContain("DRY plan=");
  });
});
