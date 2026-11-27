import { fetchWithToken, type TokenProvider } from "./app-token.js";

const GITHUB_API = "https://api.github.com";

export interface GhFile {
  sha: string;
  text: string;
}

/**
 * The compare-and-set file port over the GitHub contents API. `writeFile`
 * sends the sha it read, so a write over a stale read comes back
 * `conflict` (HTTP 409) and the caller reads again. A write with a null sha
 * is create-only: it returns `conflict` when the file already exists.
 */
export interface GhStore {
  readFile(path: string): Promise<GhFile | null>;
  writeFile(
    path: string,
    text: string,
    sha: string | null,
    message: string,
  ): Promise<"ok" | "conflict">;
  listDir(path: string): Promise<string[]>;
}

export function utf8ToBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

function base64ToUtf8(base64: string): string {
  const binary = atob(base64.replace(/\s+/g, ""));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new TextDecoder().decode(bytes);
}

export function githubStore(repo: string, tokens: TokenProvider): GhStore {
  async function ghFetch(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<Response> {
    return fetchWithToken(tokens, (token) =>
      fetch(`${GITHUB_API}${path}`, {
        method,
        headers: {
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "podcast-night",
          Authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
  }

  return {
    async readFile(path: string): Promise<GhFile | null> {
      const res = await ghFetch(
        "GET",
        `/repos/${repo}/contents/${encodeURI(path)}`,
      );
      if (res.status === 404) return null;
      if (!res.ok) {
        throw new Error(`GitHub GET ${path} failed with status ${res.status}`);
      }
      const data = (await res.json()) as { sha?: string; content?: string };
      if (typeof data.sha !== "string" || typeof data.content !== "string") {
        throw new Error(`GitHub GET ${path} returned no file content`);
      }
      return { sha: data.sha, text: base64ToUtf8(data.content) };
    },

    async writeFile(
      path: string,
      text: string,
      sha: string | null,
      message: string,
    ): Promise<"ok" | "conflict"> {
      const res = await ghFetch("PUT", `/repos/${repo}/contents/${encodeURI(path)}`, {
        message,
        content: utf8ToBase64(text),
        ...(sha === null ? {} : { sha }),
      });
      // A create (no sha) over an existing file answers 422; a stale sha answers 409.
      if (res.status === 409 || (sha === null && res.status === 422)) return "conflict";
      if (!res.ok) {
        throw new Error(`GitHub PUT ${path} failed with status ${res.status}`);
      }
      return "ok";
    },

    async listDir(path: string): Promise<string[]> {
      const res = await ghFetch(
        "GET",
        `/repos/${repo}/contents/${encodeURI(path)}`,
      );
      if (res.status === 404) return [];
      if (!res.ok) {
        throw new Error(`GitHub GET ${path}/ failed with status ${res.status}`);
      }
      const data = (await res.json()) as { name?: string; type?: string }[];
      if (!Array.isArray(data)) return [];
      return data
        .filter((entry) => entry.type === "file" && typeof entry.name === "string")
        .map((entry) => entry.name as string);
    },
  };
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
