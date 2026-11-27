import { foldReceipts } from "./receipt.js";

/** Port over issue comments: look for a marker, then post. */
export interface IssueComments {
  hasComment(issue: number, marker: string, sinceIso: string): Promise<boolean>;
  post(issue: number, body: string): Promise<void>;
}

export function summaryMarker(date: string): string {
  return `<!-- podcast-night:${date}/summary -->`;
}

function num(value: unknown): string {
  return typeof value === "number" ? String(value) : "?";
}

/**
 * One line per finished night: date, the picked video per slot and the
 * durations. Ids and numbers only; no transcript or script text.
 */
export function summaryBody(date: string, lines: string[]): string {
  const byNode = foldReceipts(lines);
  const picks = [1, 2, 3].map((slot) => {
    const t = byNode.get(`transcript-${slot}`);
    const id =
      t !== undefined && (t.status === "done" || t.status === "filled")
        ? t.output.video_id
        : null;
    return `${slot}=${typeof id === "string" ? id : "none"}`;
  });
  const content = byNode.get("content");
  const voice = byNode.get("voice");
  return [
    `podcast-night ${date} trial: picks ${picks.join(" ")}`,
    `script ${num(content?.output.chars)} chars`,
    `audio ${num(voice?.output.duration_s)} s`,
    "check done, deliver done",
  ]
    .join("; ")
    .concat(`\n\n${summaryMarker(date)}`);
}

export function githubComments(
  repo: string,
  token: string | undefined,
): IssueComments {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "podcast-night",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
  const MAX_PAGES = 5;
  return {
    async hasComment(issue, marker, sinceIso): Promise<boolean> {
      for (let page = 1; page <= MAX_PAGES; page += 1) {
        const res = await fetch(
          `https://api.github.com/repos/${repo}/issues/${issue}/comments?per_page=100&page=${page}&since=${encodeURIComponent(sinceIso)}`,
          { headers },
        );
        if (!res.ok) throw new Error(`GitHub GET comments failed with status ${res.status}`);
        const data = (await res.json()) as { body?: string }[];
        if (data.some((c) => typeof c.body === "string" && c.body.includes(marker))) {
          return true;
        }
        if (data.length < 100) return false;
      }
      return false;
    },
    async post(issue, body): Promise<void> {
      const res = await fetch(
        `https://api.github.com/repos/${repo}/issues/${issue}/comments`,
        {
          method: "POST",
          headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify({ body }),
        },
      );
      if (!res.ok) throw new Error(`GitHub POST comment failed with status ${res.status}`);
    },
  };
}
