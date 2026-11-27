export interface TopicConfig {
  slot: number;
  name: string;
  queries: string[];
}

export interface BacklogEntry {
  video_id: string;
  slot: number;
}

export interface PodcastConfig {
  enabled: boolean;
  mode: "trial" | "live";
  /** Tenant the tool 2 and tool 3 jobs run as; the instance names it, the code does not. */
  tenant?: string;
  slots: [string, string, string];
  content_at: string;
  topics: TopicConfig[];
  backlog: BacklogEntry[];
  channel_boost: Record<string, number>;
  deny_channels: string[];
}

const HHMM = /^\d{2}:\d{2}$/;
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
/** Same slug grammar as the tools' tenants document (`src/ids.ts` upstream). */
const TENANT_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;

function err(path: string, want: string): { ok: false; error: string } {
  return { ok: false, error: `${path} must be ${want}` };
}

/**
 * Runtime check for `config.schema.json`: instance
 * `research/morning-podcast/config.json` parsed into PodcastConfig.
 */
export function parseConfig(
  text: string,
): { ok: true; config: PodcastConfig } | { ok: false; error: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: "config is not valid JSON" };
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, error: "config must be an object" };
  }
  const c = raw as Record<string, unknown>;
  if (typeof c.enabled !== "boolean") return err("enabled", "a boolean");
  if (c.mode !== "trial" && c.mode !== "live") {
    return err("mode", '"trial" or "live"');
  }
  if (c.tenant !== undefined && (typeof c.tenant !== "string" || !TENANT_ID.test(c.tenant))) {
    return err("tenant", "a tenant id slug");
  }
  if (
    !Array.isArray(c.slots) ||
    c.slots.length !== 3 ||
    c.slots.some((s) => typeof s !== "string" || !HHMM.test(s as string))
  ) {
    return err("slots", "three HH:MM strings");
  }
  if (c.content_at !== undefined && (typeof c.content_at !== "string" || !HHMM.test(c.content_at))) {
    return err("content_at", "an HH:MM string");
  }
  if (!Array.isArray(c.topics)) return err("topics", "an array");
  const topics: TopicConfig[] = [];
  for (const [i, t] of c.topics.entries()) {
    if (typeof t !== "object" || t === null) return err(`topics[${i}]`, "an object");
    const topic = t as Record<string, unknown>;
    if (!Number.isInteger(topic.slot) || (topic.slot as number) < 1 || (topic.slot as number) > 3) {
      return err(`topics[${i}].slot`, "an integer 1..3");
    }
    if (typeof topic.name !== "string" || topic.name.length === 0) {
      return err(`topics[${i}].name`, "a non-empty string");
    }
    if (!Array.isArray(topic.queries) || topic.queries.some((q) => typeof q !== "string")) {
      return err(`topics[${i}].queries`, "an array of strings");
    }
    topics.push({ slot: topic.slot as number, name: topic.name, queries: topic.queries as string[] });
  }
  if (!Array.isArray(c.backlog)) return err("backlog", "an array");
  const backlog: BacklogEntry[] = [];
  for (const [i, b] of c.backlog.entries()) {
    if (typeof b !== "object" || b === null) return err(`backlog[${i}]`, "an object");
    const entry = b as Record<string, unknown>;
    if (typeof entry.video_id !== "string" || !VIDEO_ID.test(entry.video_id)) {
      return err(`backlog[${i}].video_id`, "an 11-character video id");
    }
    if (!Number.isInteger(entry.slot) || (entry.slot as number) < 1 || (entry.slot as number) > 3) {
      return err(`backlog[${i}].slot`, "an integer 1..3");
    }
    backlog.push({ video_id: entry.video_id, slot: entry.slot as number });
  }
  if (c.channel_boost !== undefined) {
    if (typeof c.channel_boost !== "object" || c.channel_boost === null) {
      return err("channel_boost", "an object of numbers");
    }
    for (const v of Object.values(c.channel_boost)) {
      if (typeof v !== "number") return err("channel_boost", "an object of numbers");
    }
  }
  if (c.deny_channels !== undefined) {
    if (!Array.isArray(c.deny_channels) || c.deny_channels.some((d) => typeof d !== "string")) {
      return err("deny_channels", "an array of strings");
    }
  }
  return {
    ok: true,
    config: {
      enabled: c.enabled,
      mode: c.mode,
      tenant: typeof c.tenant === "string" ? c.tenant : undefined,
      slots: c.slots as [string, string, string],
      content_at: typeof c.content_at === "string" ? c.content_at : "03:00",
      topics,
      backlog,
      channel_boost: (c.channel_boost as Record<string, number> | undefined) ?? {},
      deny_channels: (c.deny_channels as string[] | undefined) ?? [],
    },
  };
}
