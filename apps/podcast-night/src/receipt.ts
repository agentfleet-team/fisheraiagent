export type ReceiptStatus = "done" | "filled" | "failed" | "escalated";

/**
 * One line of the night run record, RFC-001 `docs/morning-podcast/rfc/`.
 * `output` holds only ids, counts and hashes — never transcript text,
 * script text or secrets.
 */
export interface Receipt {
  v: 1;
  date: string;
  node: string;
  key: string;
  status: ReceiptStatus;
  attempt: number;
  input_sha256: string | null;
  output: Record<string, unknown>;
  error: string | null;
  at: string;
  by: string;
}

const STATUSES = new Set<ReceiptStatus>(["done", "filled", "failed", "escalated"]);

// Every output key a writer of this record may set. Transcript text,
// script text and secrets have no key here, so a receipt cannot carry them.
const OUTPUT_KEYS = new Set([
  "video_id",
  "backup_id",
  "score",
  "reason",
  "slot",
  "source",
  "blocks",
  "transcript_sha256",
  "path",
  "chars",
  "script_sha256",
  "file_id",
  "duration_s",
  "bytes",
  "audio_sha256",
  "audio_file_id",
  "marks_file_id",
  "job_id",
  "config_sha",
  "config_sha256",
  "count",
  "pool_sha256",
  "enabled",
  "mode",
]);
const OUTPUT_STRING_MAX = 200;

function isScalar(value: unknown): boolean {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

/** Executable form of the RFC-001 receipt shape. Returns error strings; empty means valid. */
export function validateReceipt(raw: unknown): string[] {
  const errors: string[] = [];
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return ["receipt is not an object"];
  }
  const r = raw as Record<string, unknown>;
  if (r.v !== 1) errors.push("v must be 1");
  if (typeof r.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(r.date)) {
    errors.push("date must be YYYY-MM-DD");
  }
  if (typeof r.node !== "string" || r.node.length === 0) {
    errors.push("node must be a non-empty string");
  }
  if (
    typeof r.key !== "string" ||
    r.key !== `${String(r.date)}/${String(r.node)}`
  ) {
    errors.push("key must be <date>/<node>");
  }
  if (typeof r.status !== "string" || !STATUSES.has(r.status as ReceiptStatus)) {
    errors.push("status must be done|filled|failed|escalated");
  }
  if (!Number.isInteger(r.attempt) || (r.attempt as number) < 1) {
    errors.push("attempt must be an integer >= 1");
  }
  if (r.input_sha256 !== null && typeof r.input_sha256 !== "string") {
    errors.push("input_sha256 must be a string or null");
  }
  if (typeof r.output !== "object" || r.output === null || Array.isArray(r.output)) {
    errors.push("output must be an object");
  } else {
    for (const [key, value] of Object.entries(r.output)) {
      if (!OUTPUT_KEYS.has(key)) errors.push(`output.${key} is not an allowed key`);
      if (!isScalar(value)) errors.push(`output.${key} must be a scalar`);
      if (typeof value === "string" && value.length > OUTPUT_STRING_MAX) {
        errors.push(`output.${key} exceeds ${OUTPUT_STRING_MAX} chars`);
      }
    }
  }
  if (r.error !== null && typeof r.error !== "string") {
    errors.push("error must be a string or null");
  }
  if (typeof r.at !== "string" || Number.isNaN(Date.parse(r.at))) {
    errors.push("at must be an ISO timestamp");
  }
  if (typeof r.by !== "string" || r.by.length === 0) {
    errors.push("by must be a non-empty string");
  }
  return errors;
}

/** Parses one record line. Returns null for a blank or malformed line. */
export function parseReceiptLine(line: string): Receipt | null {
  const trimmed = line.trim();
  if (trimmed === "") return null;
  try {
    const raw: unknown = JSON.parse(trimmed);
    return validateReceipt(raw).length === 0 ? (raw as Receipt) : null;
  } catch {
    return null;
  }
}

/** Last line per node wins. */
export function foldReceipts(lines: string[]): Map<string, Receipt> {
  const byNode = new Map<string, Receipt>();
  for (const line of lines) {
    const receipt = parseReceiptLine(line);
    if (receipt !== null) byNode.set(receipt.node, receipt);
  }
  return byNode;
}
