import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.js";
import { validateReceipt, type Receipt } from "../src/receipt.js";

const APP_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");

function baseReceipt(output: Record<string, unknown>): Receipt {
  return {
    v: 1,
    date: "2026-11-28",
    node: "transcript-1",
    key: "2026-11-28/transcript-1",
    status: "done",
    attempt: 1,
    input_sha256: "a".repeat(64),
    output,
    error: null,
    at: "2026-11-27T16:30:00.000Z",
    by: "podcast-night@0.1.0",
  };
}

describe("A8: every receipt validates against the RFC-001 shape", () => {
  const valid = [
    baseReceipt({ config_sha: "abc123", enabled: true, mode: "trial" }),
    baseReceipt({ video_id: "jVBlkOF8sHk", backup_id: "hWe-j78vNpc", score: 3, reason: "backlog" }),
    baseReceipt({
      video_id: "jVBlkOF8sHk",
      source: "gemini",
      blocks: 812,
      transcript_sha256: "b".repeat(64),
      path: "research/morning-podcast/runs/2026-11-28/transcript-1.json",
      job_id: "job-1",
    }),
    { ...baseReceipt({ video_id: "jVBlkOF8sHk" }), status: "failed", error: "upstream_error", attempt: 2 },
    { ...baseReceipt({}), status: "escalated", error: "config_not_found" },
  ];

  it("accepts each node receipt shape", () => {
    for (const receipt of valid) {
      expect(validateReceipt(receipt)).toEqual([]);
    }
  });

  it("rejects receipts outside the shape", () => {
    const bad: [string, unknown][] = [
      ["not an object", "x"],
      ["v not 1", { ...baseReceipt({}), v: 2 }],
      ["key not date/node", { ...baseReceipt({}), key: "other" }],
      ["bad status", { ...baseReceipt({}), status: "pending" }],
      ["attempt 0", { ...baseReceipt({}), attempt: 0 }],
      ["output not object", { ...baseReceipt({}), output: "x" }],
      ["unknown output key", baseReceipt({ nonsense: 1 })],
      ["nested output", baseReceipt({ video_id: { nested: true } })],
      ["bad at", { ...baseReceipt({}), at: "not a time" }],
    ];
    for (const [, receipt] of bad) {
      expect(validateReceipt(receipt).length).toBeGreaterThan(0);
    }
  });

  it("no receipt carries transcript text", () => {
    const text = "x".repeat(500);
    const receipt = baseReceipt({ video_id: "jVBlkOF8sHk", transcript: text });
    expect(validateReceipt(receipt).length).toBeGreaterThan(0);
    const longReason = baseReceipt({ reason: text });
    expect(validateReceipt(longReason).length).toBeGreaterThan(0);
  });
});

describe("config.json contract", () => {
  it("the fixture validates against parseConfig", () => {
    const text = readFileSync(join(APP_DIR, "fixtures/config.json"), "utf8");
    const result = parseConfig(text);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.slots).toEqual(["00:00", "01:00", "02:00"]);
      expect(result.config.backlog.length).toBe(7);
    }
  });

  it("the JSON schema file exists, is valid JSON and covers the fixture keys", () => {
    const schema = JSON.parse(
      readFileSync(join(APP_DIR, "config.schema.json"), "utf8"),
    ) as { required: string[]; properties: Record<string, unknown> };
    const fixture = JSON.parse(
      readFileSync(join(APP_DIR, "fixtures/config.json"), "utf8"),
    ) as Record<string, unknown>;
    for (const key of schema.required) {
      expect(fixture).toHaveProperty(key);
    }
    for (const key of Object.keys(fixture)) {
      expect(schema.properties).toHaveProperty(key);
    }
  });

  it("rejects malformed configs", () => {
    expect(parseConfig("not json").ok).toBe(false);
    expect(parseConfig("{}").ok).toBe(false);
    expect(parseConfig('{"enabled":"yes","mode":"trial","slots":["00:00","01:00","02:00"],"topics":[],"backlog":[]}').ok).toBe(false);
    expect(
      parseConfig(
        JSON.stringify({
          enabled: true,
          mode: "trial",
          slots: ["0:00", "01:00", "02:00"],
          topics: [],
          backlog: [],
        }),
      ).ok,
    ).toBe(false);
    expect(
      parseConfig(
        JSON.stringify({
          enabled: true,
          mode: "trial",
          slots: ["00:00", "01:00", "02:00"],
          topics: [],
          backlog: [{ video_id: "too-short", slot: 1 }],
        }),
      ).ok,
    ).toBe(false);
  });
});

describe("wrangler contract", () => {
  it("cron is the amended */5 night window with no routes", () => {
    const raw = readFileSync(join(APP_DIR, "wrangler.jsonc"), "utf8");
    const wrangler = JSON.parse(raw) as {
      triggers: { crons: string[] };
      workers_dev: boolean;
      preview_urls: boolean;
      vars: Record<string, string>;
    };
    expect(wrangler.triggers.crons).toEqual(["*/5 16-22 * * *"]);
    expect(wrangler.workers_dev).toBe(false);
    expect(wrangler.preview_urls).toBe(false);
    expect(wrangler.vars.DRY_RUN).toBe("true");
  });
});
