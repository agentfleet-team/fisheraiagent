import { afterEach, describe, expect, it, vi } from "vitest";
import { runTick, worker, type Env } from "../src/worker.js";

const BASE_ENV: Required<Pick<Env, "STATE_REPO" | "SUMMARY_REPO" | "SUMMARY_ISSUE">> = {
  STATE_REPO: "example-org/state-repo",
  SUMMARY_REPO: "example-org/summary-repo",
  SUMMARY_ISSUE: "42",
};

function spiedPorts() {
  const store = {
    readFile: vi.fn(async () => null),
    writeFile: vi.fn(async () => "ok" as const),
    listDir: vi.fn(async () => []),
  };
  const tool1 = {
    submit: vi.fn(async () => ({ kind: "job" as const, jobId: "t1" })),
    poll: vi.fn(async () => ({ kind: "running" as const })),
  };
  const tool2 = {
    submit: vi.fn(async () => ({ kind: "job" as const, jobId: "t2" })),
    poll: vi.fn(async () => ({ kind: "running" as const })),
  };
  const tool3 = {
    submit: vi.fn(async () => ({ kind: "job" as const, jobId: "t3" })),
    poll: vi.fn(async () => ({ kind: "running" as const })),
  };
  const comments = {
    hasComment: vi.fn(async () => false),
    post: vi.fn(async () => undefined),
  };
  const search = vi.fn(async () => ({ ok: true as const, entries: [] }));
  return { store, tool1, tool2, tool3, comments, search };
}

function expectZeroPortCalls(ports: ReturnType<typeof spiedPorts>): void {
  expect(ports.store.readFile).not.toHaveBeenCalled();
  expect(ports.store.writeFile).not.toHaveBeenCalled();
  expect(ports.store.listDir).not.toHaveBeenCalled();
  expect(ports.tool1.submit).not.toHaveBeenCalled();
  expect(ports.tool1.poll).not.toHaveBeenCalled();
  expect(ports.tool2.submit).not.toHaveBeenCalled();
  expect(ports.tool2.poll).not.toHaveBeenCalled();
  expect(ports.tool3.submit).not.toHaveBeenCalled();
  expect(ports.tool3.poll).not.toHaveBeenCalled();
  expect(ports.comments.hasComment).not.toHaveBeenCalled();
  expect(ports.comments.post).not.toHaveBeenCalled();
  expect(ports.search).not.toHaveBeenCalled();
}

describe("M4: required instance Env vars", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("fails before any port call when STATE_REPO is missing", async () => {
    const ports = spiedPorts();
    const { STATE_REPO: _omit, ...env } = BASE_ENV;
    const outcome = await runTick({ ...ports, env, now: new Date("2026-11-28T00:00:00+08:00"), dryRun: false });
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toBe("missing_env:STATE_REPO");
    expect(outcome.appended).toEqual([]);
    expectZeroPortCalls(ports);
  });

  it("fails before any port call when SUMMARY_REPO is missing", async () => {
    const ports = spiedPorts();
    const { SUMMARY_REPO: _omit, ...env } = BASE_ENV;
    const outcome = await runTick({ ...ports, env, now: new Date("2026-11-28T00:00:00+08:00"), dryRun: false });
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toBe("missing_env:SUMMARY_REPO");
    expect(outcome.appended).toEqual([]);
    expectZeroPortCalls(ports);
  });

  it("fails before any port call when SUMMARY_ISSUE is missing", async () => {
    const ports = spiedPorts();
    const { SUMMARY_ISSUE: _omit, ...env } = BASE_ENV;
    const outcome = await runTick({ ...ports, env, now: new Date("2026-11-28T00:00:00+08:00"), dryRun: false });
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toBe("missing_env:SUMMARY_ISSUE");
    expect(outcome.appended).toEqual([]);
    expectZeroPortCalls(ports);
  });

  it.each([
    ["STATE_REPO", "", "missing_env:STATE_REPO"],
    ["STATE_REPO", "no-slash", "invalid_env:STATE_REPO"],
    ["STATE_REPO", "a/b/c", "invalid_env:STATE_REPO"],
    ["STATE_REPO", "owner/..", "invalid_env:STATE_REPO"],
    ["STATE_REPO", "owner/.", "invalid_env:STATE_REPO"],
    ["STATE_REPO", "bad.owner/repo", "invalid_env:STATE_REPO"],
    ["STATE_REPO", "bad_owner/repo", "invalid_env:STATE_REPO"],
    ["STATE_REPO", "-owner/repo", "invalid_env:STATE_REPO"],
    ["STATE_REPO", "owner-/repo", "invalid_env:STATE_REPO"],
    ["STATE_REPO", "bad--owner/repo", "invalid_env:STATE_REPO"],
    ["STATE_REPO", `${"a".repeat(40)}/repo`, "invalid_env:STATE_REPO"],
    ["STATE_REPO", `owner/${"a".repeat(101)}`, "invalid_env:STATE_REPO"],
    ["SUMMARY_REPO", "", "missing_env:SUMMARY_REPO"],
    ["SUMMARY_REPO", "owner/", "invalid_env:SUMMARY_REPO"],
    ["SUMMARY_REPO", "/repo", "invalid_env:SUMMARY_REPO"],
    ["SUMMARY_REPO", "owner/..", "invalid_env:SUMMARY_REPO"],
    ["SUMMARY_REPO", "bad.owner/repo", "invalid_env:SUMMARY_REPO"],
    ["SUMMARY_REPO", "bad_owner/repo", "invalid_env:SUMMARY_REPO"],
    ["SUMMARY_REPO", "-owner/repo", "invalid_env:SUMMARY_REPO"],
    ["SUMMARY_REPO", "owner-/repo", "invalid_env:SUMMARY_REPO"],
    ["SUMMARY_REPO", "bad--owner/repo", "invalid_env:SUMMARY_REPO"],
    ["SUMMARY_ISSUE", "", "missing_env:SUMMARY_ISSUE"],
    ["SUMMARY_ISSUE", "0", "invalid_env:SUMMARY_ISSUE"],
    ["SUMMARY_ISSUE", "-3", "invalid_env:SUMMARY_ISSUE"],
    ["SUMMARY_ISSUE", "12abc", "invalid_env:SUMMARY_ISSUE"],
  ] as const)("fails before any port call when %s is %j", async (key, value, expectedError) => {
    const ports = spiedPorts();
    const outcome = await runTick({
      ...ports,
      env: { ...BASE_ENV, [key]: value },
      now: new Date("2026-11-28T00:00:00+08:00"),
      dryRun: false,
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toBe(expectedError);
    expect(outcome.appended).toEqual([]);
    expectZeroPortCalls(ports);
  });

  it("reaches the store when instance vars are valid", async () => {
    const ports = spiedPorts();
    const outcome = await runTick({
      ...ports,
      env: { ...BASE_ENV, STATE_REPO: "example-org/.github" },
      now: new Date("2026-11-28T00:00:00+08:00"),
      dryRun: false,
    });
    expect(outcome.ok).toBe(true);
    expect(ports.store.readFile).toHaveBeenCalled();
  });

  it("worker.scheduled makes zero fetch calls when an instance var is missing", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { SUMMARY_ISSUE: _omit, ...env } = BASE_ENV;
    await worker.scheduled(
      { scheduledTime: Date.parse("2026-11-28T00:00:00+08:00"), cron: "*/5 16-22 * * *", noRetry: () => {} },
      { ...env, DRY_RUN: "false" } as Env,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("missing_env:SUMMARY_ISSUE"));
  });

  it("worker.scheduled reaches the store for valid config and makes zero fetch calls for malformed repo owners", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 404 }));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const controller = {
      scheduledTime: Date.parse("2026-11-28T00:00:00+08:00"),
      cron: "*/5 16-22 * * *",
      noRetry: () => {},
    };

    await worker.scheduled(controller, { ...BASE_ENV, DRY_RUN: "false" });
    expect(fetchSpy.mock.calls.length).toBeGreaterThan(0);

    for (const key of ["STATE_REPO", "SUMMARY_REPO"] as const) {
      fetchSpy.mockClear();
      errSpy.mockClear();
      await worker.scheduled(controller, { ...BASE_ENV, [key]: "bad.owner/repo", DRY_RUN: "false" });
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining(`invalid_env:${key}`));
    }
  });
});
