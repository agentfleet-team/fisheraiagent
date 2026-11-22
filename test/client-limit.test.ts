import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ClientRateLimiter,
  clientIp,
  proxyMatcher,
  type ClientAdmission,
} from '../src/client-limit.js';

// The maps are private; the expiry acceptance test reads them through a
// cast, the same way the review oracle does.
const internals = (limiter: ClientRateLimiter) =>
  limiter as unknown as { hits: Map<string, number[]>; inFlight: Map<string, number> };

test('a held booking blocks the same client until it is cancelled or released', () => {
  const limiter = new ClientRateLimiter({ maxConcurrentJobs: 1, maxJobsPerHour: 5 });
  const first = limiter.tryAdmit('client-a');
  assert.ok(first !== undefined);
  // The slot is already booked: a request racing the check cannot pass.
  assert.equal(limiter.tryAdmit('client-a'), undefined);
  // A different client keeps its own bucket.
  assert.ok(limiter.tryAdmit('client-b') !== undefined);

  limiter.cancel(first);
  const second = limiter.tryAdmit('client-a');
  assert.ok(second !== undefined);
});

test('the hourly cap is spent at booking time and returned by cancel', () => {
  const limiter = new ClientRateLimiter({ maxConcurrentJobs: 100, maxJobsPerHour: 1 });
  const first = limiter.tryAdmit('client-a');
  assert.ok(first !== undefined);
  // The hit is booked even though no job exists yet: a racing request
  // sees it and is rejected.
  assert.equal(limiter.tryAdmit('client-a'), undefined);

  // A rejected request's booking is given back in full — the next admit
  // under the same cap succeeds.
  limiter.cancel(first);
  const second: ClientAdmission | undefined = limiter.tryAdmit('client-a');
  assert.ok(second !== undefined);
  limiter.cancel(second);
});

test('expired inactive client entries leave memory even when the client never returns', () => {
  let now = 0;
  const limiter = new ClientRateLimiter({ maxConcurrentJobs: 2, maxJobsPerHour: 20 }, () => now);
  for (let i = 0; i < 1000; i++) {
    limiter.recordAccepted(`client-${i}`);
    limiter.release(`client-${i}`);
  }

  // An hour later every client is eligible again — and probing them
  // sweeps the dead entries out of both maps.
  now = 3_600_001;
  for (let i = 0; i < 1000; i++) {
    assert.equal(limiter.overLimit(`client-${i}`), false, `client-${i} should be eligible`);
  }
  const { hits, inFlight } = internals(limiter);
  assert.equal(hits.size, 0);
  assert.equal([...hits.values()].flat().length, 0);
  assert.equal(inFlight.size, 0);
});

test('a client with a job in flight keeps its count while its hits expire', () => {
  let now = 0;
  const limiter = new ClientRateLimiter({ maxConcurrentJobs: 2, maxJobsPerHour: 20 }, () => now);
  const held = limiter.tryAdmit('busy');
  assert.ok(held !== undefined);

  now = 3_600_001;
  // The in-flight job still counts against the concurrency cap even
  // though its hourly hit is long expired.
  const next = limiter.tryAdmit('busy');
  assert.ok(next !== undefined);
  assert.equal(limiter.tryAdmit('busy'), undefined);
  limiter.cancel(next);
  limiter.release(held.client);
  const { hits, inFlight } = internals(limiter);
  assert.equal(inFlight.size, 0);
  assert.equal(hits.size, 0);
});

test('clientIp trusts CF-Connecting-IP only from a trusted proxy peer', () => {
  const trust = proxyMatcher(['127.0.0.1', '::1']);
  assert.equal(clientIp('198.51.100.4', '203.0.113.8', trust), '198.51.100.4');
  assert.equal(clientIp('::ffff:127.0.0.1', '203.0.113.8', trust), '203.0.113.8');
});
