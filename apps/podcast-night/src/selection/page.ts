/**
 * YouTube results-page parser (RFC-003).
 * Reads `ytInitialData` from a results page and returns every video
 * entry with the fields the pool needs: id, title, channel, duration
 * seconds, view count, age in hours and the CC badge. YouTube serves
 * two layouts: `videoRenderer` and `lockupViewModel`. No per-video
 * call is made (the player endpoint is bot-walled, fisheraiagent#75).
 */

export interface PageEntry {
  id: string;
  title: string | null;
  channel: string | null;
  durationSec: number | null;
  views: number | null;
  ageHours: number | null;
  ageText: string | null;
  cc: boolean;
}

export type PageParseResult =
  | { ok: true; entries: PageEntry[] }
  | { ok: false; error: "no_yt_initial_data" | "yt_initial_data_not_json" };

const DUR_RE = /^\d{1,3}:\d{2}(:\d{2})?$/;
const AGE_TAIL_RE = /(\d+(?:\.\d+)?)\s*(seconds?|secs?|s|minutes?|mins?|hours?|hrs?|h|days?|d|weeks?|w|months?|mos?|years?|yrs?|y)\s+ago/i;

const AGE_UNIT_HOURS: Record<string, number> = {
  s: 1 / 3600,
  sec: 1 / 3600,
  secs: 1 / 3600,
  second: 1 / 3600,
  seconds: 1 / 3600,
  min: 1 / 60,
  mins: 1 / 60,
  minute: 1 / 60,
  minutes: 1 / 60,
  h: 1,
  hr: 1,
  hrs: 1,
  hour: 1,
  hours: 1,
  d: 24,
  day: 24,
  days: 24,
  w: 168,
  week: 168,
  weeks: 168,
  mo: 720,
  mos: 720,
  month: 720,
  months: 720,
  y: 8760,
  yr: 8760,
  yrs: 8760,
  year: 8760,
  years: 8760,
};

const VIEW_MULTIPLIERS: Record<string, number> = {
  k: 1e3,
  m: 1e6,
  b: 1e9,
  thousand: 1e3,
  million: 1e6,
  billion: 1e9,
};

/** "2d ago", "Streamed 3 days ago", "Premiered 5 hours ago" -> hours. */
export function parseAgeHours(text: string): number | null {
  const match = AGE_TAIL_RE.exec(text);
  if (match === null) return null;
  const unit = AGE_UNIT_HOURS[match[2].toLowerCase()];
  return unit === undefined ? null : Number(match[1]) * unit;
}

/** "39,823 views", "9.5 thousand views", "9.5K", "No views" -> a count. */
export function parseViewCount(text: string): number | null {
  const t = text.trim().toLowerCase().replace(/,/g, "");
  if (t === "no views") return 0;
  const match = /^([\d.]+)\s*(k|m|b|thousand|million|billion)?(?:\s*views?)?$/.exec(t);
  if (match === null) return null;
  const multiplier = match[2] === undefined ? 1 : VIEW_MULTIPLIERS[match[2]];
  if (multiplier === undefined) return null;
  return Math.round(Number(match[1]) * multiplier);
}

function str(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function leafStrings(value: unknown, acc: string[] = []): string[] {
  if (typeof value === "string") {
    acc.push(value);
  } else if (isRecord(value)) {
    for (const v of Object.values(value)) leafStrings(v, acc);
  } else if (Array.isArray(value)) {
    for (const v of value) leafStrings(v, acc);
  }
  return acc;
}

/** runs[].text joined, or simpleText, or content (the three text shapes). */
function textOf(node: unknown): string | null {
  if (!isRecord(node)) return null;
  if (Array.isArray(node.runs)) {
    const text = node.runs
      .map((run) => (isRecord(run) && typeof run.text === "string" ? run.text : ""))
      .join("");
    if (text !== "") return text;
  }
  return str(node.simpleText) ?? str(node.content);
}

function firstRunText(node: unknown): string | null {
  if (!isRecord(node) || !Array.isArray(node.runs)) return null;
  const first = node.runs[0];
  return isRecord(first) ? str(first.text) : null;
}

function durTextToSec(text: string): number {
  return text
    .split(":")
    .map(Number)
    .reduce((sec, part) => sec * 60 + part, 0);
}

/** A CC badge is `{"label": "CC"}` (videoRenderer) or `{"badgeText": "CC"}` (lockup). */
function hasCcBadge(entry: Record<string, unknown>): boolean {
  const walk = (value: unknown): boolean => {
    if (isRecord(value)) {
      if (value.label === "CC" || value.badgeText === "CC") return true;
      return Object.values(value).some(walk);
    }
    if (Array.isArray(value)) return value.some(walk);
    return false;
  };
  return walk(entry);
}

function parseVideoRenderer(r: Record<string, unknown>): PageEntry | null {
  const id = str(r.videoId);
  if (id === null) return null;
  const dur = textOf(r.lengthText);
  const ageText = textOf(r.publishedTimeText);
  const viewsText = textOf(r.viewCountText) ?? textOf(r.shortViewCountText);
  return {
    id,
    title: textOf(r.title),
    channel:
      firstRunText(r.ownerText) ??
      firstRunText(r.shortBylineText) ??
      firstRunText(r.longBylineText),
    durationSec: dur !== null && DUR_RE.test(dur) ? durTextToSec(dur) : null,
    views: viewsText === null ? null : parseViewCount(viewsText),
    ageHours: ageText === null ? null : parseAgeHours(ageText),
    ageText,
    cc: hasCcBadge(r),
  };
}

function parseLockup(r: Record<string, unknown>): PageEntry | null {
  if (r.contentType !== "LOCKUP_CONTENT_TYPE_VIDEO") return null;
  const id = str(r.contentId);
  if (id === null) return null;
  const meta = isRecord(r.metadata)
    ? (r.metadata.lockupMetadataViewModel as Record<string, unknown> | undefined)
    : undefined;
  const title = isRecord(meta?.title) ? str(meta.title.content) : null;

  const rows = isRecord(meta?.metadata)
    ? ((meta.metadata as Record<string, unknown>).contentMetadataViewModel as
        | Record<string, unknown>
        | undefined)?.metadataRows
    : undefined;
  const parts: Record<string, unknown>[] = [];
  if (Array.isArray(rows)) {
    for (const row of rows) {
      if (!isRecord(row) || !Array.isArray(row.metadataParts)) continue;
      for (const part of row.metadataParts) {
        if (isRecord(part)) parts.push(part);
      }
    }
  }

  let channel: string | null = null;
  for (const part of parts) {
    const stack = isRecord(part.avatarStack)
      ? (part.avatarStack.avatarStackViewModel as Record<string, unknown> | undefined)
      : undefined;
    if (isRecord(stack?.text) && str(stack.text.content) !== null) {
      channel = str(stack.text.content);
      break;
    }
  }
  if (channel === null) {
    const goTo = leafStrings(meta)
      .map((s) => /^Go to channel (.+)$/.exec(s))
      .find((m) => m !== null);
    channel = goTo?.[1] ?? null;
  }

  let views: number | null = null;
  let ageText: string | null = null;
  for (const part of parts) {
    const content = isRecord(part.text) ? str(part.text.content) : null;
    const a11y = str(part.accessibilityLabel);
    if (views === null && a11y !== null && /\bviews?$/i.test(a11y)) {
      views = parseViewCount(a11y) ?? (content === null ? null : parseViewCount(content));
    }
    if (ageText === null && content !== null && /\bago$/i.test(content)) {
      ageText = content;
    }
  }

  const dur = leafStrings(r.contentImage).find((s) => DUR_RE.test(s)) ?? null;
  return {
    id,
    title,
    channel,
    durationSec: dur === null ? null : durTextToSec(dur),
    views,
    ageHours: ageText === null ? null : parseAgeHours(ageText),
    ageText,
    cc: hasCcBadge(r),
  };
}

/** Finds `ytInitialData = {...}` and brace-matches it (string-aware). */
export function extractInitialData(html: string): unknown | null {
  const re = /ytInitialData\s*=\s*\{/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html)) !== null) {
    const start = match.index + match[0].length - 1;
    let depth = 0;
    let inStr = false;
    let esc = false;
    let end = -1;
    for (let i = start; i < html.length; i += 1) {
      const c = html[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === "\\") esc = true;
        else if (c === '"') inStr = false;
      } else if (c === '"') inStr = true;
      else if (c === "{") depth += 1;
      else if (c === "}") {
        depth -= 1;
        if (depth === 0) {
          end = i + 1;
          break;
        }
      }
    }
    if (end < 0) continue;
    try {
      return JSON.parse(html.slice(start, end));
    } catch {
      // Try the next assignment.
    }
  }
  return null;
}

/**
 * Parses a results page into video entries in document order.
 * A page with no readable `ytInitialData` is a typed error, not an
 * empty list (an empty list would look like a legitimately empty
 * search result).
 */
export function parseResultsPage(html: string): PageParseResult {
  const data = extractInitialData(html);
  if (data === null) return { ok: false, error: "no_yt_initial_data" };
  if (!isRecord(data)) return { ok: false, error: "yt_initial_data_not_json" };
  const entries: PageEntry[] = [];
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const v of value) walk(v);
      return;
    }
    if (!isRecord(value)) return;
    for (const [key, v] of Object.entries(value)) {
      if (key === "videoRenderer" && isRecord(v)) {
        const entry = parseVideoRenderer(v);
        if (entry !== null) entries.push(entry);
      } else if (key === "lockupViewModel" && isRecord(v)) {
        const entry = parseLockup(v);
        if (entry !== null) entries.push(entry);
      } else {
        walk(v);
      }
    }
  };
  walk(data.contents ?? data);
  return { ok: true, entries };
}
