// Per-client limits on job creation for the public, unauthenticated
// surface (Issue #43). A client is a source IP: the Cloudflare-provided
// CF-Connecting-IP header when the request's own peer is a trusted proxy
// (the cloudflared connector the tunnel runs next to), otherwise the
// socket address — a header from anywhere else is caller-controlled text
// and is ignored. In-memory only, like the job store: a restart resets
// the counters, which errs toward letting a few extra jobs through.
import { isIP } from 'node:net';
import { TranscriptError } from './errors.js';

export interface ClientLimits {
  // In-flight (queued or running) jobs one client may hold at once.
  maxConcurrentJobs: number;
  // Accepted submissions one client may make in a sliding hour.
  maxJobsPerHour: number;
}

export const DEFAULT_MAX_CONCURRENT_JOBS_PER_CLIENT = 2;
export const DEFAULT_MAX_JOBS_PER_HOUR_PER_CLIENT = 20;

// A peer allowed to speak for the real client IP via CF-Connecting-IP.
// The documented deployment runs cloudflared in the same task or host, so
// the default trusts loopback peers only; anything else must be listed
// explicitly or the header is ignored.
export const DEFAULT_TRUSTED_PROXY_IPS: readonly string[] = ['127.0.0.1', '::1'];

const HOUR_MS = 60 * 60 * 1000;

// TRUSTED_PROXY_IPS env text -> the peer list. Empty or unset means the
// loopback default; the word "none" trusts no peer (the header is always
// ignored). Each entry is a full IPv4/IPv6 address or an IPv4 CIDR; a
// malformed entry fails config load rather than being silently dropped.
export function parseTrustedProxyIps(raw: string): string[] {
  const text = raw.trim();
  if (text === '') return [...DEFAULT_TRUSTED_PROXY_IPS];
  if (text.toLowerCase() === 'none') return [];
  const entries = text
    .split(',')
    .map((e) => e.trim())
    .filter((e) => e !== '');
  for (const entry of entries) checkProxyEntry(entry);
  return entries;
}

type ProxyRule = { kind: 'ip'; ip: string } | { kind: 'v4net'; base: number; bits: number };

// One entry: an exact address, or an IPv4 CIDR whose parts are checked.
function ruleFor(entry: string): ProxyRule | undefined {
  if (isIP(entry) !== 0) return { kind: 'ip', ip: entry };
  const slash = entry.indexOf('/');
  if (slash < 0) return undefined;
  const parts = entry.slice(0, slash).split('.');
  const bitsText = entry.slice(slash + 1);
  if (!/^\d{1,2}$/.test(bitsText)) return undefined;
  const bits = Number(bitsText);
  if (parts.length !== 4 || bits > 32) return undefined;
  let base = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return undefined;
    const octet = Number(part);
    if (octet > 255) return undefined;
    base = base * 256 + octet;
  }
  return { kind: 'v4net', base, bits };
}

function checkProxyEntry(entry: string): ProxyRule {
  const rule = ruleFor(entry);
  if (rule === undefined) {
    throw new TranscriptError(
      'invalid_config',
      `TRUSTED_PROXY_IPS: "${entry}" is not an IP address or an IPv4 CIDR`,
    );
  }
  return rule;
}

// A checker for whether a request's socket peer may supply the client IP.
// Built once at service start; a malformed entry fails startup.
export function proxyMatcher(entries: readonly string[]): (ip: string) => boolean {
  const rules = entries.map((entry) => checkProxyEntry(entry));
  return (ip) => rules.some((rule) => ruleMatches(rule, ip));
}

function ipv4ToNumber(ip: string): number {
  let value = 0;
  for (const part of ip.split('.')) value = value * 256 + Number(part);
  return value;
}

function ruleMatches(rule: ProxyRule, ip: string): boolean {
  if (rule.kind === 'ip') return rule.ip === ip;
  if (isIP(ip) !== 4) return false;
  if (rule.bits === 0) return true;
  const mask = (0xffffffff << (32 - rule.bits)) >>> 0;
  return (ipv4ToNumber(ip) & mask) === (rule.base & mask);
}

function normalizeIp(ip: string | undefined): string | undefined {
  if (ip === undefined) return undefined;
  return ip.startsWith('::ffff:') ? ip.slice('::ffff:'.length) : ip;
}

// The client identity a request's jobs are counted against. The header
// wins only when the peer itself is a trusted proxy — through the tunnel
// Cloudflare overwrites CF-Connecting-IP with the real client IP, while a
// request that did not come through the tunnel can forge it, so untrusted
// peers are keyed on their socket address. A missing, multiple or
// non-IP header value falls back to the peer as well.
export function clientIp(
  remoteAddress: string | undefined,
  cfConnectingIp: string | string[] | undefined,
  isTrustedProxy: (ip: string) => boolean,
): string {
  const peer = normalizeIp(remoteAddress);
  const header = Array.isArray(cfConnectingIp) ? undefined : cfConnectingIp;
  if (peer !== undefined && header !== undefined && isTrustedProxy(peer)) {
    const value = header.trim();
    if (isIP(value) !== 0) return value;
  }
  return peer ?? 'unknown';
}

// One booked submission: the client bucket it is held under and the
// hourly timestamp it took. A request that is rejected after booking
// hands the ticket to `cancel`; a submitted job keeps the hourly hit and
// its in-flight half is returned through `release` when it settles.
export interface ClientAdmission {
  readonly client: string;
  readonly at: number;
}

// Per-client counters: a sliding window of booked submissions plus the
// jobs each client still has in flight. `tryAdmit` checks both caps and
// books the slot in one synchronous step — there is no read-then-book
// gap, so requests racing the check cannot overshoot a cap. Entries
// expire out of `hits` when the client is next seen and through a
// throttled sweep on the admit path, so a client that never returns does
// not stay in memory forever; in-flight counts live in their own map and
// are untouched by expiry.
export class ClientRateLimiter {
  private readonly hits = new Map<string, number[]>();
  private readonly inFlight = new Map<string, number>();
  private sweptAt = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly limits: ClientLimits,
    private readonly now: () => number = () => Date.now(),
  ) {}

  // Whether one more submission from this client would exceed either
  // cap — a read-only probe. The request path admits through `tryAdmit`
  // so the check and the booking stay one atomic step.
  overLimit(client: string): boolean {
    this.sweep();
    if ((this.inFlight.get(client) ?? 0) >= this.limits.maxConcurrentJobs) return true;
    return this.recent(client).length >= this.limits.maxJobsPerHour;
  }

  // Books one submission unconditionally — one in-flight slot and one
  // hourly hit. `tryAdmit` is the checked form the request path uses.
  recordAccepted(client: string): void {
    this.inFlight.set(client, (this.inFlight.get(client) ?? 0) + 1);
    this.hits.set(client, [...this.recent(client), this.now()]);
  }

  // One synchronous check-and-book: the caller leaves either holding a
  // slot (an in-flight share plus one hourly hit) or rejected with no
  // state changed. Run before the request body is read so a flood is
  // answered 429 without parse or key work.
  tryAdmit(client: string): ClientAdmission | undefined {
    if (this.overLimit(client)) return undefined;
    const at = this.now();
    this.hits.set(client, [...this.recent(client), at]);
    this.inFlight.set(client, (this.inFlight.get(client) ?? 0) + 1);
    return { client, at };
  }

  // Gives back a booking whose request was rejected before it became a
  // job: the hourly hit and the in-flight slot both return, so a rejected
  // request consumes no allowance.
  cancel(ticket: ClientAdmission): void {
    this.release(ticket.client);
    const list = this.hits.get(ticket.client);
    if (list === undefined) return;
    const index = list.lastIndexOf(ticket.at);
    if (index >= 0) list.splice(index, 1);
    if (list.length === 0) this.hits.delete(ticket.client);
  }

  // Returns one in-flight slot when a job reaches a terminal state.
  release(client: string): void {
    const left = (this.inFlight.get(client) ?? 0) - 1;
    if (left <= 0) this.inFlight.delete(client);
    else this.inFlight.set(client, left);
  }

  // The client's still-valid hits, pruned in place: expiry is written
  // back on every read so a returning client's dead entries leave memory,
  // and an empty list drops the map entry entirely.
  private recent(client: string): number[] {
    const cutoff = this.now() - HOUR_MS;
    const kept = (this.hits.get(client) ?? []).filter((t) => t > cutoff);
    if (kept.length === 0) this.hits.delete(client);
    else this.hits.set(client, kept);
    return kept;
  }

  // Whole-map expiry for clients that never return, run at most once a
  // minute on the admit path — per-request cost stays bounded while dead
  // entries cannot outlive the sweep interval by much.
  private sweep(): void {
    const now = this.now();
    if (now - this.sweptAt < 60_000) return;
    this.sweptAt = now;
    const cutoff = now - HOUR_MS;
    for (const [client, list] of this.hits) {
      const kept = list.filter((t) => t > cutoff);
      if (kept.length === 0) this.hits.delete(client);
      else this.hits.set(client, kept);
    }
  }
}
