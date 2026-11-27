import { readFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { runTick } from "../src/worker.js";

it("runs the due pool before any later stage on the first enabled tick at content_at", async () => {
  const configPath = "research/morning-podcast/config.json";
  const files = new Map([
    [configPath, { sha: "config", text: readFileSync("fixtures/config.json", "utf8") }],
  ]);
  const fail = () => { throw Error("Unexpected external side effect"); };
  const search = vi.fn(async () => ({ ok: true as const, entries: [] }));
  const tick = await runTick({
    store: {
      readFile: async (path) => files.get(path) ?? null,
      writeFile: async (path, text) => { files.set(path, { sha: path, text }); return "ok"; },
      listDir: async () => [],
    },
    tool1: { submit: async () => ({ kind: "job", jobId: "local" }), poll: async () => ({ kind: "running" }) },
    tool2: { submit: fail, poll: fail },
    tool3: { submit: fail, poll: fail },
    comments: { post: fail, hasComment: fail },
    env: {
      STATE_REPO: "fisherivco/allen-state",
      SUMMARY_REPO: "fisherivco/allen-ai-os",
      SUMMARY_ISSUE: "1878",
    },
    search,
    now: new Date("2026-11-28T03:00:00+08:00"),
    dryRun: false,
  });
  expect(tick.appended.map(({ node, status }) => [node, status]).slice(0, 2))
    .toEqual([["config", "done"], ["pool", "done"]]);
  expect(search).toHaveBeenCalled();
  expect(files.has("research/morning-podcast/runs/2026-11-28/pool.json")).toBe(true);
});
