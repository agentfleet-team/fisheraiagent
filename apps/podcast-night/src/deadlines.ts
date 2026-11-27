/**
 * Deadline table of RFC-001 (Asia/Taipei, HH:MM). A node with no receipt
 * after its deadline is a stall the watchdog reports; the router itself
 * only reads the `content` and `voice` rows, to end a first attempt that
 * still runs after its deadline and use the single fill.
 */
export const DEADLINES: Readonly<Record<string, string>> = {
  config: "00:15",
  pool: "00:15",
  "pick-1": "00:15",
  "pick-2": "01:15",
  "pick-3": "02:15",
  "transcript-1": "00:55",
  "transcript-2": "01:55",
  "transcript-3": "02:55",
  content: "03:30",
  voice: "04:15",
  check: "04:20",
  deliver: "06:45",
};

/** The instant a node's deadline falls on the given Taipei date, or null for an unknown node. */
export function deadlineInstant(date: string, node: string): number | null {
  const hhmm = DEADLINES[node];
  return hhmm === undefined ? null : Date.parse(`${date}T${hhmm}:00+08:00`);
}
