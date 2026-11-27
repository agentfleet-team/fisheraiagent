import { describe, expect, it, vi } from "vitest";
import { appTokens, fetchWithToken, hasAppSecrets } from "../src/app-token.js";
import { githubStore } from "../src/github.js";
import { githubComments } from "../src/summary.js";
import { buildTickDeps, worker, type Env } from "../src/worker.js";

function b64(bytes: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)));
}
function unb64url(s: string): Uint8Array {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

async function makeKey() {
  const pair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  const pkcs8 = b64(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  const pem = `-----${"BEGIN"} PRIVATE KEY-----\n${pkcs8.match(/.{1,64}/g)!.join("\n")}\n-----${"END"} PRIVATE KEY-----\n`;
  return { pem, pub: pair.publicKey };
}

const NOW = Date.parse("2026-11-28T00:00:00Z");

function stub(expiresAt: string) {
  const calls: { url: string; init: RequestInit }[] = [];
  let n = 0;
  const fetchFn = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    n += 1;
    return new Response(JSON.stringify({ token: `ghs_FAKE_TOKEN_${n}`, expires_at: expiresAt }), { status: 201 });
  }) as unknown as typeof fetch;
  return { calls, fetchFn };
}

describe("app tokens", () => {
  it("A1 signs a verifiable RS256 JWT and sends narrowed bodies", async () => {
    const { pem, pub } = await makeKey();
    const { calls, fetchFn } = stub("2026-11-28T01:00:00Z");
    const apps = appTokens(
      { GITHUB_APP_ID: "123", GITHUB_APP_INSTALLATION_ID: "456", GITHUB_APP_PRIVATE_KEY: pem },
      { now: () => NOW, fetchFn },
    );
    await apps.scope({ repo: "allen-state", permission: "contents" }).get();
    await apps.scope({ repo: "allen-ai-os", permission: "issues" }).get();
    expect(calls.map((c) => c.url)).toEqual([
      "https://api.github.com/app/installations/456/access_tokens",
      "https://api.github.com/app/installations/456/access_tokens",
    ]);
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
      repositories: ["allen-state"],
      permissions: { contents: "write" },
    });
    expect(JSON.parse(calls[1]!.init.body as string)).toEqual({
      repositories: ["allen-ai-os"],
      permissions: { issues: "write" },
    });
    const auth = (calls[0]!.init.headers as Record<string, string>).Authorization!;
    const [h, p, s] = auth.replace("Bearer ", "").split(".") as [string, string, string];
    expect(JSON.parse(new TextDecoder().decode(unb64url(h)))).toEqual({ alg: "RS256", typ: "JWT" });
    const claims = JSON.parse(new TextDecoder().decode(unb64url(p)));
    expect(claims.iss).toBe("123");
    expect(claims.iat).toBe(NOW / 1000 - 60);
    expect(claims.exp - NOW / 1000).toBeLessThanOrEqual(600);
    expect(
      await crypto.subtle.verify("RSASSA-PKCS1-v1_5", pub, unb64url(s) as BufferSource, new TextEncoder().encode(`${h}.${p}`)),
    ).toBe(true);
  });

  it("A2 caches until expiry minus 5 min, then mints again", async () => {
    const { pem } = await makeKey();
    const { calls, fetchFn } = stub("2026-11-28T01:00:00Z");
    let now = NOW;
    const apps = appTokens(
      { GITHUB_APP_ID: "1", GITHUB_APP_INSTALLATION_ID: "2", GITHUB_APP_PRIVATE_KEY: pem },
      { now: () => now, fetchFn },
    );
    const p = apps.scope({ repo: "r", permission: "contents" });
    const first = await p.get();
    now = Date.parse("2026-11-28T00:54:59Z");
    expect(await p.get()).toBe(first);
    expect(calls).toHaveLength(1);
    now = Date.parse("2026-11-28T00:55:00Z");
    expect(await p.get()).not.toBe(first);
    expect(calls).toHaveLength(2);
  });

  it("A2 mints once more and retries once after a 401", async () => {
    const { pem } = await makeKey();
    const { calls, fetchFn } = stub("2026-11-28T01:00:00Z");
    const apps = appTokens(
      { GITHUB_APP_ID: "1", GITHUB_APP_INSTALLATION_ID: "2", GITHUB_APP_PRIVATE_KEY: pem },
      { now: () => NOW, fetchFn },
    );
    const seen: string[] = [];
    const res = await fetchWithToken(apps.scope({ repo: "r", permission: "issues" }), async (t) => {
      seen.push(t);
      return new Response("", { status: seen.length === 1 ? 401 : 200 });
    });
    expect(res.status).toBe(200);
    expect(seen).toEqual(["ghs_FAKE_TOKEN_1", "ghs_FAKE_TOKEN_2"]);
    expect(calls).toHaveLength(2);
    const still401 = await fetchWithToken(apps.scope({ repo: "r", permission: "issues" }), async () => new Response("", { status: 401 }));
    expect(still401.status).toBe(401);
  });

  it("A3 never logs or throws the key, JWT or token", async () => {
    const { pem } = await makeKey();
    const body = pem.split("\n")[1]!;
    const { calls, fetchFn } = stub("2026-11-28T01:00:00Z");
    const lines: string[] = [];
    const env = { GITHUB_APP_ID: "1", GITHUB_APP_INSTALLATION_ID: "2", GITHUB_APP_PRIVATE_KEY: pem };
    const apps = appTokens(env, { now: () => NOW, fetchFn, log: (l) => lines.push(l) });
    await apps.scope({ repo: "allen-state", permission: "contents" }).get();
    expect(lines).toEqual(["token minted repo=allen-state perm=contents"]);
    const jwt = (calls[0]!.init.headers as Record<string, string>).Authorization!.slice(7);
    const bad = appTokens(env, {
      now: () => NOW,
      fetchFn: (async () => new Response(`{"message":"${jwt} ghs_FAKE_TOKEN_1"}`, { status: 401 })) as unknown as typeof fetch,
    });
    const err = await bad.scope({ repo: "r", permission: "issues" }).get().catch((e: Error) => e.message);
    const keyErr = await appTokens({ ...env, GITHUB_APP_PRIVATE_KEY: "not a key" }, { fetchFn })
      .scope({ repo: "r", permission: "issues" }).get().catch((e: Error) => e.message);
    const all = [...lines, String(err), String(keyErr)].join("\n");
    for (const secret of [body, jwt, "ghs_FAKE_TOKEN_1", "not a key"]) expect(all).not.toContain(secret);
  });

  it("A1 store and comments send the minted token", async () => {
    const seen: string[] = [];
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation((async (_u: string, init: RequestInit) => {
      seen.push((init.headers as Record<string, string>).Authorization!);
      return new Response("[]", { status: 200 });
    }) as unknown as typeof fetch);
    const tp = { get: async () => "tok", renew: async () => "tok2" };
    await githubComments("o/r", tp).hasComment(1, "m", "2026-01-01T00:00:00Z");
    await githubStore("o/r", tp).listDir("x");
    spy.mockRestore();
    expect(seen).toEqual(["Bearer tok", "Bearer tok"]);
  });

  it("A4 missing secrets fail the tick with one fixed error and no GitHub call", async () => {
    expect(hasAppSecrets({ GITHUB_APP_ID: "1", GITHUB_APP_INSTALLATION_ID: "2" })).toBe(false);
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const env = { STATE_REPO: "o/s", SUMMARY_REPO: "o/m", SUMMARY_ISSUE: "1", GITHUB_APP_ID: "1" } as Env;
    await worker.scheduled({ scheduledTime: NOW } as ScheduledController, env);
    expect(err.mock.calls).toEqual([["tick error=missing_secret:github_app"]]);
    expect(fetchSpy).not.toHaveBeenCalled();
    err.mockRestore();
    fetchSpy.mockRestore();
    expect(buildTickDeps({ STATE_REPO: "o/s", SUMMARY_REPO: "o/m", SUMMARY_ISSUE: "1" } as Env, new Date(NOW)).store).toBeDefined();
  });
});
