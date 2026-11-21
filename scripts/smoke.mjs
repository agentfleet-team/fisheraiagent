// Offline smoke check against a running service (default http://localhost:8080).
// Prints the /healthz status and the status + error code of a keyless POST.
const base = (process.env.SMOKE_URL ?? 'http://localhost:8080').replace(/\/+$/, '');
const url = process.env.SMOKE_VIDEO_URL ?? 'https://youtu.be/hWe-j78vNpc';

const health = await fetch(`${base}/healthz`);
console.log(`GET /healthz -> ${health.status}`);

const res = await fetch(`${base}/v1/jobs`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ url }),
});
const body = await res.json().catch(() => ({}));
const code = body?.error?.code ?? 'none';
console.log(`POST /v1/jobs (no X-Gemini-Key) -> ${res.status} ${code}`);

if (health.status !== 200 || res.status !== 400 || code !== 'missing_key') {
  console.error('smoke: unexpected response');
  process.exit(1);
}
