import { afterEach, describe, expect, it, vi } from "vitest";
import { httpTool1 } from "../src/tool1.js";

const SEED = "seed-token-value-1";

/** Tool 1's real request contract: a JSON object, `url` a string, `tenant` an optional string, nothing else. */
function stubFetch(seen: { body: Record<string, unknown>; auth: string | null }[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      const parsed = JSON.parse(String(init.body)) as Record<string, unknown>;
      const keys = Object.keys(parsed);
      const bad =
        typeof parsed.url !== "string" ||
        keys.some((k) => k !== "url" && k !== "tenant") ||
        ("tenant" in parsed && typeof parsed.tenant !== "string");
      const headers = init.headers as Record<string, string>;
      seen.push({ body: parsed, auth: headers.Authorization ?? null });
      return new Response(JSON.stringify(bad ? { error: { code: "invalid_request" } } : { job_id: "j1" }), {
        status: bad ? 400 : 202,
      });
    }),
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("httpTool1.submit body", () => {
  it("sends tenant when one is named", async () => {
    const seen: { body: Record<string, unknown>; auth: string | null }[] = [];
    stubFetch(seen);
    const r = await httpTool1("https://t.example", SEED).submit("https://youtu.be/abcdefghijk", "podcast-trial");
    expect(r).toEqual({ kind: "job", jobId: "j1" });
    expect(seen[0].body).toEqual({ url: "https://youtu.be/abcdefghijk", tenant: "podcast-trial" });
  });

  it("omits tenant when none is named", async () => {
    const seen: { body: Record<string, unknown>; auth: string | null }[] = [];
    stubFetch(seen);
    const r = await httpTool1("https://t.example", SEED).submit("https://youtu.be/abcdefghijk");
    expect(r).toEqual({ kind: "job", jobId: "j1" });
    expect(seen[0].body).not.toHaveProperty("tenant");
  });

  it("the stub rejects a body shape the real tool would reject", async () => {
    const seen: { body: Record<string, unknown>; auth: string | null }[] = [];
    stubFetch(seen);
    const res = await fetch("https://t.example/v1/jobs", {
      method: "POST",
      headers: {},
      body: JSON.stringify({ url: "x", tenant: 5, extra: 1 }),
    });
    expect(res.status).toBe(400);
  });

  it("leak check: the token reaches only the Authorization header, and the check can fail", async () => {
    const seen: { body: Record<string, unknown>; auth: string | null }[] = [];
    stubFetch(seen);
    await httpTool1("https://t.example", SEED).submit("https://youtu.be/abcdefghijk", "podcast-trial");
    expect(seen[0].auth).toBe(`Bearer ${SEED}`);
    expect(JSON.stringify(seen[0].body)).not.toContain(SEED);
    // Proof the check can fail: a body seeded with the token is caught.
    expect(JSON.stringify({ ...seen[0].body, leaked: SEED })).toContain(SEED);
  });
});
