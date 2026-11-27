import { describe, expect, it } from "vitest";
import { DEADLINES, deadlineInstant } from "../src/deadlines.js";
import type { GhStore } from "../src/github.js";
import type {
  EpisodeRequest,
  EpisodeScript,
  JobPoll,
  JobTool,
  VoiceRequest,
  VoiceResult,
} from "../src/jobtool.js";
import { parseReceiptLine, type Receipt } from "../src/receipt.js";
import { summaryMarker, type IssueComments } from "../src/summary.js";
import { expectSeconds } from "../src/tail.js";
import type { PollResult, SubmitResult, Tool1, TranscriptDoc } from "../src/tool1.js";
import { runTick } from "../src/worker.js";
import { parseEpisodeRequest } from "../../../src/digest/contract.js";
import { parseVoiceRequest } from "../../../src/voice/contract.js";

const RUNS = "research/morning-podcast/runs";
const CONFIG_PATH = "research/morning-podcast/config.json";
const DATE = "2026-11-28";
const RECORD_PATH = `${RUNS}/${DATE}.jsonl`;
const BY = "podcast-night@0.1.0";

// 2026-11-28 00:00 Asia/Taipei == 2026-11-27T16:00:00Z.
const at = (hhmm: string) => new Date(`2026-11-27T${hhmm}:00Z`);
// Taipei clock HH:MM on DATE to a Date.
const taipei = (hhmm: string) => new Date(`${DATE}T${hhmm}:00+08:00`);

const V1 = "jVBlkOF8sHk";
const V2 = "hWe-j78vNpc";
const V3 = "37ROC7uPieE";
const V4 = "eKhog2ZXlQg";
const V5 = "r0Mm_79yKso";

function configJson(
  mode: "trial" | "live" = "trial",
  tenants?: { trial?: string; live?: string },
): string {
  return JSON.stringify({
    enabled: true,
    mode,
    ...(tenants === undefined ? {} : { tenants }),
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
    ],
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
    input_sha256: null,
    output,
    error: status === "done" || status === "filled" ? null : "err",
    at: "2026-11-27T16:00:00.000Z",
    by: BY,
  });
}

function doc(videoId: string): TranscriptDoc {
  return {
    video_id: videoId,
    source_url: `https://www.youtube.com/watch?v=${videoId}`,
    language: "en",
    source: "captions:auto",
    blocks: [{ start: 0, end: 5, text: "TRANSCRIPT TEXT MARKER" }],
  };
}

class FakeStore implements GhStore {
  files = new Map<string, { sha: string; text: string }>();
  private seq = 0;
  private conflicts = new Map<string, number>();

  seed(path: string, text: string): void {
    this.files.set(path, { sha: `seed-${this.seq++}`, text });
  }

  /** The next `count` writes to path come back 409 without touching the file. */
  conflict(path: string, count: number): void {
    this.conflicts.set(path, count);
  }

  async readFile(path: string) {
    const file = this.files.get(path);
    return file === undefined ? null : { sha: file.sha, text: file.text };
  }
  async writeFile(path: string, text: string, sha: string | null) {
    const injected = this.conflicts.get(path) ?? 0;
    if (injected > 0) {
      this.conflicts.set(path, injected - 1);
      return "conflict" as const;
    }
    const current = this.files.get(path);
    if (sha === null && current !== undefined) return "conflict" as const;
    if (sha !== null && current?.sha !== sha) return "conflict" as const;
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
  receipts(): Receipt[] {
    return (this.files.get(RECORD_PATH)?.text ?? "")
      .split("\n")
      .map((line) => parseReceiptLine(line))
      .filter((r): r is Receipt => r !== null);
  }
  nodes(): string[] {
    return this.receipts().map((r) => r.node);
  }
  last(node: string): Receipt {
    const found = this.receipts().filter((r) => r.node === node).at(-1);
    if (found === undefined) throw new Error(`no receipt for ${node}`);
    return found;
  }
}

/** Canonical JSON text: keys sorted, so equal parsed requests compare equal. */
function canon(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canon(item)).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    const entries = Object.keys(record)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canon(record[k])}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Upstream `IDEMPOTENCY_KEY_FORMAT`: printable ASCII without space, 1 to 200 characters. */
const KEY_FORMAT = /^[\x21-\x7e]{1,200}$/;

/**
 * A tool 2 or tool 3 stub that follows upstream `src/digest/service.ts` and
 * `src/voice/service.ts`, in this order: (a) the body fails the parser, 400
 * `invalid_request`, whatever the key; (b) a present key (trimmed) that is
 * malformed, 400 `invalid_request`; (c) no key or a new key, a new job; (d) a
 * seen key with the same parsed request, the same job; (e) a seen key with a
 * different parsed request, 409 `idempotency_conflict`. The parsed request is
 * canonical JSON of the parser output, so unknown fields do not count.
 */
class FakeJobTool<Req, Res> implements JobTool<Req, Res> {
  submits: { body: Req; key: string }[] = [];
  private jobs = new Map<string, JobPoll<Res>[]>();
  private byKey = new Map<string, { jobId: string; request: string }>();
  private count = 0;
  constructor(
    private script: (n: number, body: Req) => JobPoll<Res>[],
    private parse: (body: unknown) => unknown,
  ) {}

  async submit(body: Req, rawKey: string | undefined): Promise<SubmitResult> {
    this.submits.push({ body, key: rawKey as string });
    const parsed = this.parse(body);
    if (parsed === undefined) return { kind: "fatal", error: "invalid_request" };
    const key = rawKey?.trim();
    if (key !== undefined && !KEY_FORMAT.test(key)) {
      return { kind: "fatal", error: "invalid_request" };
    }
    const request = canon(parsed);
    const known = key === undefined ? undefined : this.byKey.get(key);
    if (known !== undefined) {
      return known.request === request
        ? { kind: "job", jobId: known.jobId }
        : { kind: "fatal", error: "idempotency_conflict" };
    }
    const jobId = `job-${this.count}`;
    this.count += 1;
    if (key !== undefined) this.byKey.set(key, { jobId, request });
    this.jobs.set(jobId, this.script(this.count, body));
    return { kind: "job", jobId };
  }
  async poll(jobId: string): Promise<JobPoll<Res>> {
    const views = this.jobs.get(jobId);
    if (views === undefined) return { kind: "not_found" };
    return views.length > 1 ? (views.shift() as JobPoll<Res>) : views[0];
  }
}

class FakeComments implements IssueComments {
  posted: { issue: number; body: string }[] = [];
  /** Markers already on the issue, as after a crash between the comment and the receipt. */
  existing: string[] = [];
  async hasComment(_issue: number, marker: string) {
    return this.existing.includes(marker) || this.posted.some((p) => p.body.includes(marker));
  }
  async post(issue: number, body: string) {
    this.posted.push({ issue, body });
  }
}

const SCRIPT_CHARS = 2600;

function script(chars = SCRIPT_CHARS, withSaved = true): EpisodeScript {
  return {
    profile: "podcast-zh-tw-10min",
    title: "Episode",
    sections: [
      { id: "opening", kind: "opening", text: "SCRIPT TEXT MARKER open" },
      { id: "s1", kind: "segment", slot: 1, video_id: V1, text: "SCRIPT TEXT MARKER one" },
      { id: "closing", kind: "closing", text: "SCRIPT TEXT MARKER close" },
    ],
    char_count: chars,
    markdown: "SCRIPT TEXT MARKER markdown",
    ...(withSaved ? { saved: { file_id: "drive-script", name: `${DATE}-script.md` } } : {}),
  };
}

function voice(duration_s = 595, withSaved = true): VoiceResult {
  return {
    duration_s,
    bytes: 3_000_000,
    sha256: "b".repeat(64),
    format: "audio-24khz-48kbitrate-mono-mp3",
    marks: [
      { section_id: "s1", index: 0, start_ms: 0, end_ms: 595_000, text: "SCRIPT TEXT MARKER one" },
    ],
    ...(withSaved
      ? {
          saved: {
            audio_file_id: "drive-audio",
            marks_file_id: "drive-marks",
            names: [`${DATE}-episode.mp3`, `${DATE}-marks.json`],
          },
        }
      : {}),
  };
}

const okTool2 = () =>
  new FakeJobTool<EpisodeRequest, EpisodeScript>(
    () => [{ kind: "done", result: script() }],
    parseEpisodeRequest,
  );
const okTool3 = () =>
  new FakeJobTool<VoiceRequest, VoiceResult>(
    () => [{ kind: "done", result: voice() }],
    parseVoiceRequest,
  );

class Tool1Stub implements Tool1 {
  submits: string[] = [];
  async submit(url: string): Promise<SubmitResult> {
    this.submits.push(url);
    return { kind: "job", jobId: url.slice(-11) };
  }
  async poll(jobId: string): Promise<PollResult> {
    return { kind: "done", result: doc(jobId) };
  }
}

interface Rig {
  store: FakeStore;
  tool2: FakeJobTool<EpisodeRequest, EpisodeScript>;
  tool3: FakeJobTool<VoiceRequest, VoiceResult>;
  comments: FakeComments;
  tick(now: Date): ReturnType<typeof runTick>;
}

function rig(
  tool2 = okTool2(),
  tool3 = okTool3(),
  mode: "trial" | "live" = "trial",
  tool1: Tool1 = new Tool1Stub(),
  tenants?: { trial?: string; live?: string },
): Rig {
  const store = new FakeStore();
  store.seed(CONFIG_PATH, configJson(mode, tenants));
  const comments = new FakeComments();
  return {
    store,
    tool2,
    tool3,
    comments,
    tick: (now) =>
      runTick({
        store,
        tool1,
        tool2,
        tool3,
        comments,
        env: {
          STATE_REPO: "fisherivco/allen-state",
          SUMMARY_REPO: "fisherivco/allen-ai-os",
          SUMMARY_ISSUE: "1878",
        },
        now,
        dryRun: false,
        by: BY,
        // A stub results page: no search hits, so the pool holds backlog only.
        search: async () => ({ ok: true as const, entries: [] }),
      }),
  };
}

/** A record where the three slots finished and `empty` slots have no pick. */
function seedSlots(r: Rig, empty: number[] = [], extra: string[] = []): void {
  const ids = [V1, V3, V5];
  const lines = [
    receipt("config", "done", { enabled: true, mode: "trial" }),
    receipt("pool", "done", { count: 0, source: "worker" }),
  ];
  ids.forEach((id, i) => {
    const slot = i + 1;
    if (empty.includes(slot)) {
      lines.push(receipt(`pick-${slot}`, "done", { video_id: null, backup_id: null, reason: "no_candidates" }));
      return;
    }
    lines.push(receipt(`pick-${slot}`, "done", { video_id: id, backup_id: null }));
    lines.push(receipt(`transcript-${slot}`, "done", { video_id: id, source: "captions:auto" }));
    r.store.seed(`${RUNS}/${DATE}/transcript-${slot}.json`, `${JSON.stringify(doc(id))}\n`);
  });
  r.store.seed(RECORD_PATH, [...lines, ...extra].join("\n") + "\n");
}

describe("podcast-night content, voice, check, deliver (fisherivco/allen-ai-os#1903)", () => {
  it("R1: three transcripts done submit one tool 2 job with missing_slots empty and the full transcripts", async () => {
    const r = rig();
    seedSlots(r);
    const out = await r.tick(taipei("03:00"));
    expect(r.tool2.submits).toHaveLength(1);
    const { body, key } = r.tool2.submits[0];
    expect(key).toBe(`${DATE}/content`);
    expect(body.missing_slots).toEqual([]);
    expect(body.profile).toBe("podcast-zh-tw-10min");
    expect(body.sources.map((s) => s.slot)).toEqual([1, 2, 3]);
    expect(body.sources[0].transcript).toEqual(doc(V1));
    expect(body.sources[0].url).toBe(`https://www.youtube.com/watch?v=${V1}`);
    const content = r.store.last("content");
    expect(content.status).toBe("done");
    expect(content.output).toMatchObject({ chars: SCRIPT_CHARS, file_id: "drive-script" });
    expect(String(content.output.script_sha256)).toMatch(/^[0-9a-f]{64}$/);
    expect(out.appended.map((x) => x.node)).toContain("content");
  });

  it("R1: content waits for content_at (03:00 Taipei)", async () => {
    const r = rig();
    seedSlots(r);
    await r.tick(taipei("02:59"));
    expect(r.tool2.submits).toEqual([]);
    expect(r.store.nodes()).not.toContain("content");
  });

  it("R1: one empty slot is named in missing_slots and its source is left out", async () => {
    const r = rig();
    seedSlots(r, [2]);
    await r.tick(taipei("03:00"));
    const { body } = r.tool2.submits[0];
    expect(body.missing_slots).toEqual([2]);
    expect(body.sources.map((s) => s.slot)).toEqual([1, 3]);
  });

  it("R1: a slot whose backup transcript also failed counts as empty", async () => {
    const r = rig();
    seedSlots(r, [], []);
    const text = r.store.files.get(RECORD_PATH)!.text.replace(
      receipt("transcript-2", "done", { video_id: V3, source: "captions:auto" }) + "\n",
      receipt("transcript-2", "failed", { video_id: V4 }, 3) + "\n",
    );
    r.store.seed(RECORD_PATH, text);
    await r.tick(taipei("03:00"));
    expect(r.tool2.submits[0].body.missing_slots).toEqual([2]);
  });

  it("R1: zero transcripts at 03:00 appends one escalated content receipt and runs no later node", async () => {
    const r = rig();
    seedSlots(r, [1, 2, 3]);
    const before = r.store.receipts().length;
    await r.tick(taipei("03:00"));
    await r.tick(taipei("03:10"));
    const added = r.store.receipts().slice(before);
    expect(added.map((x) => [x.node, x.status, x.error])).toEqual([
      ["content", "escalated", "no_transcripts"],
    ]);
    expect(r.tool2.submits).toEqual([]);
    expect(r.tool3.submits).toEqual([]);
  });

  it("R1 zero ready transcripts with tool 1 still running at the cutoff escalate content once", async () => {
    const tool1: Tool1 = {
      async submit() {
        return { kind: "job", jobId: "queued-job" };
      },
      async poll() {
        return { kind: "running" };
      },
    };
    const r = rig(okTool2(), okTool3(), "trial", tool1);
    r.store.seed(
      RECORD_PATH,
      [
        receipt("config", "done", { enabled: true, mode: "trial" }),
        ...[V1, V3, V5].map((videoId, i) =>
          receipt(`pick-${i + 1}`, "done", { video_id: videoId, backup_id: null }),
        ),
      ].join("\n") + "\n",
    );
    await r.tick(taipei("03:00"));
    await r.tick(taipei("03:10"));
    expect(
      r.store
        .receipts()
        .filter((x) => x.node === "content")
        .map((x) => [x.status, x.at]),
    ).toEqual([["escalated", taipei("03:00").toISOString()]]);
    expect(r.tool2.submits).toHaveLength(0);
    expect(r.tool3.submits).toHaveLength(0);
    expect(r.store.nodes()).not.toContain("deliver");
  });

  it("R2: a failed tool 2 job is retried once with the same input and a new key", async () => {
    const tool2 = new FakeJobTool<EpisodeRequest, EpisodeScript>(
      (n) => [
        n === 1 ? { kind: "failed", error: "upstream_timeout" } : { kind: "done", result: script() },
      ],
      parseEpisodeRequest,
    );
    const r = rig(tool2);
    seedSlots(r);
    await r.tick(taipei("03:00"));
    expect(tool2.submits.map((s) => s.key)).toEqual([`${DATE}/content`, `${DATE}/content#2`]);
    expect(tool2.submits[1].body).toEqual(tool2.submits[0].body);
    const content = r.store.receipts().filter((x) => x.node === "content");
    expect(content.map((x) => [x.status, x.attempt])).toEqual([
      ["failed", 1],
      ["done", 2],
    ]);
    expect(content[0].input_sha256).toBe(content[1].input_sha256);
  });

  it("R2 first failure preserves the body despite a config update", async () => {
    const tool2 = new FakeJobTool<EpisodeRequest, EpisodeScript>(
      (n) => {
        if (n === 1) {
          r.store.seed(CONFIG_PATH, configJson().replace("Agent workflows", "New topic title"));
          return [{ kind: "failed", error: "upstream_timeout" }];
        }
        return [{ kind: "done", result: script() }];
      },
      parseEpisodeRequest,
    );
    const r = rig(tool2);
    seedSlots(r);
    await r.tick(taipei("03:00"));
    expect(tool2.submits).toHaveLength(2);
    expect(tool2.submits[1].body).toEqual(tool2.submits[0].body);
  });

  it("R2: a second tool 2 failure appends one escalated receipt and the night stops", async () => {
    const tool2 = new FakeJobTool<EpisodeRequest, EpisodeScript>(
      () => [{ kind: "failed", error: "quota_exceeded" }],
      parseEpisodeRequest,
    );
    const r = rig(tool2);
    seedSlots(r);
    await r.tick(taipei("03:00"));
    await r.tick(taipei("03:10"));
    const content = r.store.receipts().filter((x) => x.node === "content");
    expect(content.map((x) => [x.status, x.attempt, x.error])).toEqual([
      ["failed", 1, "quota_exceeded"],
      ["escalated", 2, "quota_exceeded"],
    ]);
    expect(tool2.submits).toHaveLength(2);
    expect(r.tool3.submits).toEqual([]);
  });

  it("R2: a tool 3 job that fails twice appends one escalated voice receipt and no check", async () => {
    const tool3 = new FakeJobTool<VoiceRequest, VoiceResult>(
      () => [{ kind: "failed", error: "render_failed" }],
      parseVoiceRequest,
    );
    const r = rig(okTool2(), tool3);
    seedSlots(r);
    await r.tick(taipei("03:00"));
    await r.tick(taipei("03:10"));
    const v = r.store.receipts().filter((x) => x.node === "voice");
    expect(v.map((x) => [x.status, x.attempt])).toEqual([
      ["failed", 1],
      ["escalated", 2],
    ]);
    expect(tool3.submits.map((s) => s.key)).toEqual([`${DATE}/voice`, `${DATE}/voice#2`]);
    expect(tool3.submits[1].body).toEqual(tool3.submits[0].body);
    expect(r.store.nodes()).not.toContain("check");
  });

  it("R2: a job still running after the node deadline fails its first try and uses the fill", async () => {
    const tool2 = new FakeJobTool<EpisodeRequest, EpisodeScript>(
      (n) => [n === 1 ? { kind: "running" } : { kind: "done", result: script() }],
      parseEpisodeRequest,
    );
    const r = rig(tool2);
    seedSlots(r);
    await r.tick(taipei("03:20"));
    expect(r.store.nodes()).not.toContain("content");
    await r.tick(taipei("03:30"));
    const content = r.store.receipts().filter((x) => x.node === "content");
    expect(content.map((x) => [x.status, x.attempt, x.error])).toEqual([
      ["failed", 1, "deadline_exceeded"],
      ["done", 2, null],
    ]);
  });

  it("R2: a content fill still running past the 03:30 deadline escalates once", async () => {
    const tool2 = new FakeJobTool<EpisodeRequest, EpisodeScript>(
      (n) => [n === 1 ? { kind: "failed", error: "upstream_timeout" } : { kind: "running" }],
      parseEpisodeRequest,
    );
    const r = rig(tool2);
    seedSlots(r);
    await r.tick(taipei("03:00"));
    await r.tick(taipei("03:30"));
    const content = r.store.receipts().filter((x) => x.node === "content");
    expect(content.map((x) => [x.status, x.attempt, x.error])).toEqual([
      ["failed", 1, "upstream_timeout"],
      ["escalated", 2, "deadline_exceeded"],
    ]);
    expect(r.store.nodes()).not.toContain("voice");
  });

  it("R2: a voice fill still running past the 04:15 deadline escalates once", async () => {
    const tool3 = new FakeJobTool<VoiceRequest, VoiceResult>(
      (n) => [n === 1 ? { kind: "failed", error: "render_failed" } : { kind: "running" }],
      parseVoiceRequest,
    );
    const r = rig(okTool2(), tool3);
    seedSlots(r);
    await r.tick(taipei("03:00"));
    await r.tick(taipei("04:15"));
    const v = r.store.receipts().filter((x) => x.node === "voice");
    expect(v.map((x) => [x.status, x.attempt, x.error])).toEqual([
      ["failed", 1, "render_failed"],
      ["escalated", 2, "deadline_exceeded"],
    ]);
    expect(r.store.nodes()).not.toContain("check");
  });

  it("R2: a crash after tool 2 finished and before the receipt resubmits with the same key", async () => {
    const r = rig();
    seedSlots(r);
    // Tick 1 makes the job but its receipt write never lands: both record
    // CAS writes conflict, so the pinned request and the job stand without
    // a receipt. Tick 2 resubmits the identical body under the same key.
    r.store.conflict(RECORD_PATH, 2);
    await r.tick(taipei("03:00"));
    expect(r.store.receipts().filter((x) => x.node === "content")).toEqual([]);
    await r.tick(taipei("03:10"));
    expect(r.tool2.submits.map((s) => s.key)).toEqual([`${DATE}/content`, `${DATE}/content`]);
    expect(r.tool2.submits[1].body).toEqual(r.tool2.submits[0].body);
    expect(r.store.last("content").status).toBe("done");
  });

  it("R2: voice sends the router's voice, the script sections and expect_seconds from the script length", async () => {
    const r = rig();
    seedSlots(r);
    await r.tick(taipei("03:00"));
    const { body } = r.tool3.submits[0];
    expect(body.voice).toEqual({ engine: "edge", name: "zh-TW-HsiaoChenNeural", rate: "-12%" });
    expect(body.sections.map((s) => s.id)).toEqual(["opening", "s1", "closing"]);
    expect(body.expect_seconds).toEqual(expectSeconds(SCRIPT_CHARS));
    expect(body.expect_seconds.min).toBeLessThan(595);
    expect(body.expect_seconds.max).toBeGreaterThan(595);
    const v = r.store.last("voice");
    expect(v.output).toMatchObject({ duration_s: 595, audio_file_id: "drive-audio", marks_file_id: "drive-marks" });
  });

  it("R3: check fails when the duration is outside the band and appends one escalated receipt", async () => {
    const tool3 = new FakeJobTool<VoiceRequest, VoiceResult>(
      () => [{ kind: "done", result: voice(200) }],
      parseVoiceRequest,
    );
    const r = rig(okTool2(), tool3);
    seedSlots(r);
    await r.tick(taipei("03:00"));
    await r.tick(taipei("03:10"));
    const check = r.store.receipts().filter((x) => x.node === "check");
    expect(check).toHaveLength(1);
    expect(check[0].status).toBe("escalated");
    expect(check[0].error).toContain("duration_out_of_band");
    expect(r.store.nodes()).not.toContain("deliver");
  });

  it("R3: check passes at the band edges and fails one second past them", async () => {
    const band = expectSeconds(SCRIPT_CHARS);
    for (const [seconds, status] of [
      [band.min, "done"],
      [band.max, "done"],
      [band.min - 1, "escalated"],
      [band.max + 1, "escalated"],
    ] as const) {
      const tool3 = new FakeJobTool<VoiceRequest, VoiceResult>(
        () => [{ kind: "done", result: voice(seconds) }],
        parseVoiceRequest,
      );
      const r = rig(okTool2(), tool3);
      seedSlots(r);
      await r.tick(taipei("03:00"));
      expect(r.store.last("check").status).toBe(status);
    }
  });

  it("deliver escalates when a receipt carries no file id and never reads Drive", async () => {
    const tool2 = new FakeJobTool<EpisodeRequest, EpisodeScript>(
      () => [{ kind: "done", result: script(SCRIPT_CHARS, false) }],
      parseEpisodeRequest,
    );
    const r = rig(tool2);
    seedSlots(r);
    await r.tick(taipei("03:00"));
    const deliver = r.store.last("deliver");
    expect(deliver.status).toBe("escalated");
    expect(deliver.error).toBe("file_id_missing:content");
    expect(r.comments.posted).toEqual([]);
  });

  it("R4: in trial mode a finished night posts exactly one summary comment on #1878", async () => {
    const r = rig();
    seedSlots(r);
    await r.tick(taipei("03:00"));
    await r.tick(taipei("03:10"));
    await r.tick(taipei("03:20"));
    expect(r.comments.posted).toHaveLength(1);
    const { issue, body } = r.comments.posted[0];
    expect(issue).toBe(1878);
    expect(body).toContain(DATE);
    expect(body).toContain(`1=${V1} 2=${V3} 3=${V5}`);
    expect(body).toContain("595");
    expect(body).toContain(summaryMarker(DATE));
    expect(body).not.toContain("MARKER");
    expect(r.store.receipts().filter((x) => x.node === "summary")).toHaveLength(1);
  });

  it("R4 overlapping ticks post a single trial summary", async () => {
    const r = rig();
    seedSlots(r, [], [
      receipt("content", "done", { chars: SCRIPT_CHARS, file_id: "script" }),
      receipt("voice", "done", { duration_s: 595, audio_file_id: "audio", marks_file_id: "marks" }),
      receipt("check", "done", { duration_s: 595, chars: SCRIPT_CHARS }),
      receipt("deliver", "done", {}),
    ]);
    const outcomes = await Promise.all([r.tick(taipei("04:00")), r.tick(taipei("04:10"))]);
    expect(
      outcomes.flatMap((out) => out.appended).filter((x) => x.node === "summary"),
    ).toHaveLength(1);
    expect(r.comments.posted).toHaveLength(1);
  });

  it("R4: a crash between the comment and its receipt posts no second comment", async () => {
    const r = rig();
    seedSlots(r);
    r.comments.existing.push(summaryMarker(DATE));
    await r.tick(taipei("03:00"));
    expect(r.comments.posted).toEqual([]);
    expect(r.store.last("summary").status).toBe("done");
  });

  it("R4: in live mode a normal night posts nothing and writes no summary receipt", async () => {
    const r = rig(okTool2(), okTool3(), "live");
    seedSlots(r);
    r.store.seed(
      RECORD_PATH,
      r.store.files.get(RECORD_PATH)!.text.replace('"mode":"trial"', '"mode":"live"'),
    );
    await r.tick(taipei("03:00"));
    expect(r.store.last("deliver").status).toBe("done");
    expect(r.comments.posted).toEqual([]);
    expect(r.store.nodes()).not.toContain("summary");
  });

  it("a finished night makes no tool call and no write on a re-run", async () => {
    const r = rig();
    seedSlots(r);
    await r.tick(taipei("03:00"));
    const text = r.store.files.get(RECORD_PATH)!.text;
    const calls = [r.tool2.submits.length, r.tool3.submits.length, r.comments.posted.length];
    const out = await r.tick(taipei("05:00"));
    expect(out.appended).toEqual([]);
    expect(r.store.files.get(RECORD_PATH)!.text).toBe(text);
    expect([r.tool2.submits.length, r.tool3.submits.length, r.comments.posted.length]).toEqual(calls);
  });

  it("R5 digest and voice stubs return the required upstream result fields", async () => {
    const r = rig();
    seedSlots(r);
    await r.tick(taipei("03:00"));
    const results = await Promise.all([r.tool2.poll("job-0"), r.tool3.poll("job-0")]);
    expect(
      results.map((view) => (view.kind === "done" ? Object.keys(view.result).sort() : view.kind)),
    ).toEqual([
      ["char_count", "markdown", "profile", "saved", "sections", "title"],
      ["bytes", "duration_s", "format", "marks", "saved", "sha256"],
    ]);
  });

  it("R2 overlapping initial attempts cannot change the body of a retry", async () => {
    const tool2 = new FakeJobTool<EpisodeRequest, EpisodeScript>(
      () => [{ kind: "failed", error: "upstream_timeout" }],
      parseEpisodeRequest,
    );
    const r = rig(tool2);
    seedSlots(r);
    const gate = () => {
      let release!: () => void;
      const promise = new Promise<void>((resolve) => {
        release = resolve;
      });
      return { promise, release };
    };
    const firstRead = gate();
    const secondRead = gate();
    const firstSubmit = gate();
    const secondSubmit = gate();
    const path = `${RUNS}/${DATE}/content-request.json`;
    const read = r.store.readFile.bind(r.store);
    let reads = 0;
    r.store.readFile = async (name) => {
      const value = await read(name);
      if (name === path && reads < 2) {
        reads += 1;
        if (reads === 1) {
          firstRead.release();
          await secondRead.promise;
        } else {
          secondRead.release();
          await firstSubmit.promise;
        }
      }
      return value;
    };
    const submit = tool2.submit.bind(tool2);
    let initials = 0;
    let original: string | undefined;
    tool2.submit = async (body, key) => {
      if (key === `${DATE}/content`) {
        initials += 1;
        if (initials === 1) {
          original = JSON.stringify(body);
          const result = await submit(body, key);
          firstSubmit.release();
          await secondSubmit.promise;
          return result;
        }
        secondSubmit.release();
        if (original !== JSON.stringify(body)) {
          return { kind: "fatal", error: "idempotency_conflict" };
        }
      }
      return submit(body, key);
    };
    const first = r.tick(taipei("03:00"));
    await firstRead.promise;
    r.store.seed(CONFIG_PATH, configJson().replace("Agent workflows", "New topic title"));
    const second = r.tick(taipei("03:00"));
    await Promise.all([first, second]);
    const initial = tool2.submits.find((entry) => entry.key === `${DATE}/content`);
    const fill = tool2.submits.find((entry) => entry.key === `${DATE}/content#2`);
    expect(initial?.body.sources[0].title).toBe("Agent workflows");
    expect(fill?.body).toEqual(initial?.body);
    expect(r.store.receipts().filter((row) => row.node === "content").map((row) => row.status))
      .toEqual(["failed", "escalated"]);
  });

  it("R2: a pin that already exists is never overwritten by a later write", async () => {
    const r = rig();
    seedSlots(r);
    const path = `${RUNS}/${DATE}/content-request.json`;
    r.store.seed(path, `${JSON.stringify({ stale: true })}\n`);
    const before = r.store.files.get(path)!;
    await r.tick(taipei("03:00"));
    expect(r.store.files.get(path)).toEqual(before);
    expect(r.tool2.submits[0].body).toEqual({ stale: true });
  });

  it("the deadline table carries the RFC-001 rows in Taipei time", () => {
    expect(DEADLINES.content).toBe("03:30");
    expect(DEADLINES.voice).toBe("04:15");
    expect(DEADLINES.check).toBe("04:20");
    expect(DEADLINES.deliver).toBe("06:45");
    expect(deadlineInstant(DATE, "deliver")).toBe(taipei("06:45").getTime());
    expect(deadlineInstant(DATE, "nope")).toBeNull();
  });

  const clock: [string, string][] = Array.from({ length: 37 }, (_, i) => {
    const minutes = i * 10;
    const hh = String(Math.floor(minutes / 60)).padStart(2, "0");
    const mm = String(minutes % 60).padStart(2, "0");
    return [`${hh}:${mm}`, `${hh}:${mm}`];
  });

  it("R5: a full stubbed night from an empty record to deliver done, ticks every 10 minutes, every node receipted once", async () => {
    const r = rig();
    const reqs: string[] = [];
    for (const [label] of clock) {
      const out = await r.tick(taipei(label));
      reqs.push(...out.appended.map((x) => x.node));
    }
    const expected = [
      "config",
      "pool",
      "pick-1",
      "transcript-1",
      "pick-2",
      "transcript-2",
      "pick-3",
      "transcript-3",
      "content",
      "voice",
      "check",
      "deliver",
      "summary",
    ];
    expect(r.store.nodes()).toEqual(expected);
    expect([...reqs].sort()).toEqual([...expected].sort());
    expect(r.store.receipts().every((x) => x.status === "done")).toBe(true);
    expect(r.tool2.submits).toHaveLength(1);
    expect(r.tool3.submits).toHaveLength(1);
    expect(r.comments.posted).toHaveLength(1);
    // content did not start before 03:00 and the whole tail ran in the first tick after it.
    const contentAt = r.store.last("content").at;
    expect(Date.parse(contentAt)).toBe(taipei("03:00").getTime());
    // no transcript or script text in the record
    expect(r.store.files.get(RECORD_PATH)!.text).not.toContain("MARKER");
  });

  it("R5: the clock helper agrees with the UTC helper", () => {
    expect(taipei("00:00").getTime()).toBe(at("16:00").getTime());
  });

  it("T21: one config carrying both tenant ids sends the trial tenant in trial and the live tenant in live (fisheraiagent#112)", async () => {
    // The instance config carries both tenant ids; the router picks by mode,
    // so changing only `mode` moves both requests to the other tenant and no
    // tenant id literal sits in code.
    const tenants = { trial: "podcast-trial", live: "podcast" };
    for (const mode of ["trial", "live"] as const) {
      const r = rig(okTool2(), okTool3(), mode, new Tool1Stub(), tenants);
      seedSlots(r);
      await r.tick(taipei("03:00"));
      expect(r.tool2.submits[0].body.tenant).toBe(tenants[mode]);
      expect(r.tool3.submits[0].body.tenant).toBe(tenants[mode]);
    }
  });

  it("T21: a config without tenants sends no tenant field", async () => {
    const r = rig();
    seedSlots(r);
    await r.tick(taipei("03:00"));
    expect(r.tool2.submits[0].body).not.toHaveProperty("tenant");
    expect(r.tool3.submits[0].body).not.toHaveProperty("tenant");
  });
});

/** One valid request per tool, taken from what the router sent on a stubbed night. */
async function sentRequests() {
  const r = rig();
  seedSlots(r);
  await r.tick(taipei("03:00"));
  return { digest: r.tool2.submits[0], voice: r.tool3.submits[0] };
}

type Row = {
  step: string;
  change: (body: any) => unknown;
  key?: (key: string) => string | undefined;
  /** Submit the valid request under the key first, so the key is seen. */
  seen?: boolean;
  expected: { kind: "job"; jobId: string } | { kind: "fatal"; error: string };
};
const INVALID = { kind: "fatal", error: "invalid_request" } as const;
const CONFLICT = { kind: "fatal", error: "idempotency_conflict" } as const;
const NEW_JOB = { kind: "job", jobId: "job-1" } as const;
const REPLAY = { kind: "job", jobId: "job-0" } as const;
const same = (b: unknown) => b;

const COMMON: Row[] = [
  { step: "1 empty key", change: same, key: () => "", expected: INVALID },
  { step: "1 key with a space", change: same, key: () => "a b", expected: INVALID },
  { step: "1 key with a non-ASCII character", change: same, key: () => "k\u00e9", expected: INVALID },
  { step: "1 key over 200 characters", change: same, key: () => "k".repeat(201), expected: INVALID },
  { step: "1 key of 200 characters is accepted", change: same, key: () => "k".repeat(200), expected: NEW_JOB },
  { step: "1 key is trimmed before the check", change: same, key: () => "  trimmed  ", expected: NEW_JOB },
  { step: "3 valid body and no key", change: same, key: () => undefined, expected: NEW_JOB },
  { step: "3 valid body and a new key", change: same, key: (k) => `${k}#new`, expected: NEW_JOB },
  { step: "4 seen key and the same request", change: same, seen: true, expected: REPLAY },
  {
    step: "4 seen key and an extra top-level field only",
    change: (b) => ({ ...b, ignored: true }),
    seen: true,
    expected: REPLAY,
  },
  {
    step: "4 seen key and keys in another order",
    change: (b) => Object.fromEntries(Object.entries(b).reverse()),
    seen: true,
    expected: REPLAY,
  },
  { step: "5 seen key and a different date", change: (b) => ({ ...b, date: "2026-11-29" }), seen: true, expected: CONFLICT },
  { step: "2 body is not an object", change: () => "text", expected: INVALID },
  { step: "2 date is not a date", change: (b) => ({ ...b, date: "not-a-date" }), expected: INVALID },
  { step: "2 date is not a real day", change: (b) => ({ ...b, date: "2026-02-30" }), expected: INVALID },
  { step: "2 invalid body on a seen key", change: (b) => ({ ...b, date: "nope" }), seen: true, expected: INVALID },
  { step: "2 invalid body and a malformed key", change: (b) => ({ ...b, date: "nope" }), key: () => "a b", expected: INVALID },
];

const DIGEST_ROWS: Row[] = [
  ...COMMON,
  { step: "2 unknown profile", change: (b) => ({ ...b, profile: "other" }), expected: INVALID },
  { step: "2 no sources", change: (b) => ({ ...b, sources: [] }), expected: INVALID },
  {
    step: "2 six sources",
    change: (b) => ({
      ...b,
      sources: Array.from({ length: 6 }, (_, i) => ({
        ...b.sources[0],
        slot: i + 1,
        transcript: { ...b.sources[0].transcript, video_id: `abcdefghi${String(i).padStart(2, "0")}` },
      })),
      missing_slots: [],
    }),
    expected: INVALID,
  },
  { step: "2 slot in sources and missing_slots", change: (b) => ({ ...b, missing_slots: [b.sources[0].slot] }), expected: INVALID },
  {
    step: "2 two sources share a slot",
    change: (b) => ({ ...b, sources: [b.sources[0], { ...b.sources[1], slot: b.sources[0].slot }] }),
    expected: INVALID,
  },
  {
    step: "2 two sources share a video_id",
    change: (b) => ({
      ...b,
      sources: [b.sources[0], { ...b.sources[1], transcript: { ...b.sources[1].transcript, video_id: b.sources[0].transcript.video_id } }],
    }),
    expected: INVALID,
  },
  {
    step: "2 a source with no blocks",
    change: (b) => ({ ...b, sources: [{ ...b.sources[0], transcript: { ...b.sources[0].transcript, blocks: [] } }] }),
    expected: INVALID,
  },
  {
    step: "2 a block with end before start",
    change: (b) => ({
      ...b,
      sources: [{ ...b.sources[0], transcript: { ...b.sources[0].transcript, blocks: [{ start: 5, end: 1, text: "x" }] } }],
    }),
    expected: INVALID,
  },
  {
    step: "4 seen key and an extra field inside a source transcript",
    change: (b) => ({
      ...b,
      sources: b.sources.map((s: any) => ({ ...s, transcript: { ...s.transcript, source_url: "https://example.com/x", source: "captions" } })),
    }),
    seen: true,
    expected: REPLAY,
  },
];

const VOICE_ROWS: Row[] = [
  ...COMMON,
  { step: "2 engine is not edge", change: (b) => ({ ...b, voice: { ...b.voice, engine: "other" } }), expected: INVALID },
  { step: "2 no sections", change: (b) => ({ ...b, sections: [] }), expected: INVALID },
  { step: "2 duplicate section ids", change: (b) => ({ ...b, sections: [b.sections[0], b.sections[0]] }), expected: INVALID },
  { step: "2 blank section text", change: (b) => ({ ...b, sections: [{ id: "a", text: "  " }] }), expected: INVALID },
  { step: "2 reversed band", change: (b) => ({ ...b, expect_seconds: { min: 660, max: 540 } }), expected: INVALID },
  { step: "2 voice name malformed", change: (b) => ({ ...b, voice: { ...b.voice, name: "x" } }), expected: INVALID },
  {
    step: "4 seen key and an extra field inside voice",
    change: (b) => ({ ...b, voice: { ...b.voice, ignored: 1 } }),
    seen: true,
    expected: REPLAY,
  },
  {
    step: "5 seen key and a different band",
    change: (b) => ({ ...b, expect_seconds: { min: 1, max: 2 } }),
    seen: true,
    expected: CONFLICT,
  },
];

describe("R5 upstream request semantics", () => {
  it.each(DIGEST_ROWS)("digest stub, step $step", async (row) => {
    const { digest } = await sentRequests();
    const tool = okTool2();
    const key = `${DATE}/content`;
    if (row.seen) expect(await tool.submit(digest.body, key)).toEqual(REPLAY);
    const sendKey = row.key === undefined ? key : row.key(key);
    const first = row.expected === NEW_JOB && !row.seen;
    if (first) await tool.submit({ ...digest.body, date: "2026-11-30" }, `${key}#other`);
    expect(await tool.submit(row.change(digest.body) as EpisodeRequest, sendKey as string)).toEqual(
      first ? NEW_JOB : row.expected,
    );
  });

  it.each(VOICE_ROWS)("voice stub, step $step", async (row) => {
    const { voice } = await sentRequests();
    const tool = okTool3();
    const key = `${DATE}/voice`;
    if (row.seen) expect(await tool.submit(voice.body, key)).toEqual(REPLAY);
    const sendKey = row.key === undefined ? key : row.key(key);
    const first = row.expected === NEW_JOB && !row.seen;
    if (first) await tool.submit({ ...voice.body, date: "2026-11-30" }, `${key}#other`);
    expect(await tool.submit(row.change(voice.body) as VoiceRequest, sendKey as string)).toEqual(
      first ? NEW_JOB : row.expected,
    );
  });
});
