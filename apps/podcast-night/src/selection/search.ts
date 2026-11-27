/**
 * The keyless YouTube search call (RFC-003): one GET of the results
 * page per query, upload-date sort plus an upload-date filter — the
 * two parameters the PR #77 round-2 spike proved from the cloud.
 */
import { parseResultsPage, type PageEntry } from "./page.js";

export type SearchFilter = "week" | "month";

/** `sp` values: upload-date sort + filter (week, then month). */
export const SEARCH_PARAMS: Readonly<Record<SearchFilter, string>> = {
  week: "CAISBAgDEAE%3D",
  month: "CAISBAgEEAE%3D",
};

export function searchUrl(query: string, filter: SearchFilter): string {
  return `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}&sp=${SEARCH_PARAMS[filter]}`;
}

export type SearchResult =
  | { ok: true; entries: PageEntry[] }
  | { ok: false; error: string };

export type PageFetch = (
  query: string,
  filter: SearchFilter,
) => Promise<SearchResult>;

const PAGE_HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Accept-Language": "en-US,en;q=0.9",
  Cookie: "CONSENT=YES+cb",
};
const PAGE_TIMEOUT_MS = 30_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Fetches one results page and parses it. Every failure is a typed
 * error so the pool node can retry it as a failed attempt.
 */
export const fetchResultsPage: PageFetch = async (query, filter) => {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PAGE_TIMEOUT_MS);
  try {
    const res = await fetch(searchUrl(query, filter), {
      headers: PAGE_HEADERS,
      signal: ctrl.signal,
      redirect: "follow",
    });
    if (!res.ok) return { ok: false, error: `http_${res.status}` };
    return parseResultsPage(await res.text());
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      return { ok: false, error: "timeout" };
    }
    const cause =
      error instanceof Error && isRecord(error.cause) ? error.cause : {};
    const code = typeof cause.code === "string" ? `:${cause.code}` : "";
    return { ok: false, error: `fetch_error${code}` };
  } finally {
    clearTimeout(timer);
  }
};
