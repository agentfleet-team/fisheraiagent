// Rerunnable spike: node run.mjs <place>   (place = mac | gha)
// Writes results/<place>.json. Needs Node >= 22, uv, network access to the Edge TTS endpoint.
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, statSync, existsSync } from 'node:fs';
import { hostname, platform, arch, release } from 'node:os';

const place = process.argv[2];
if (!['mac', 'gha'].includes(place)) { console.error('usage: node run.mjs <mac|gha>'); process.exit(2); }
const RUNS = 3;
const LONG_CHARS = 20000;
const here = (p) => new URL(p, import.meta.url).pathname;
mkdirSync(here('out/'), { recursive: true });
mkdirSync(here('results/'), { recursive: true });
const fixture = here('fixture/episode-zh-tw.txt');

const engines = {
  'python-edge-tts': (out, extra) => ['uv', ['run', '--quiet', '--with', 'edge-tts', 'python', here('engine_py.py'), fixture, out, ...extra]],
  'node-msedge-tts': (out, extra) => ['node', [here('engine_node.mjs'), 'msedge-tts', fixture, out, ...extra]],
  'node-edge-tts-universal': (out, extra) => ['node', [here('engine_node.mjs'), 'edge-tts-universal', fixture, out, ...extra]],
};

function duration(file) {
  if (!existsSync(file)) return 0;
  const r = spawnSync('uv', ['run', '--quiet', '--with', 'mutagen', 'python', here('duration.py'), file], { encoding: 'utf8' });
  return Number(r.stdout.trim().split('\n').pop()) || 0;
}

function one(engine, kind, i) {
  const out = here(`out/${place}-${engine}-${kind}-${i}.mp3`);
  const extra = kind === 'long' ? ['--repeat-to', String(LONG_CHARS)] : [];
  const [cmd, args] = engines[engine](out, extra);
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 25 * 60 * 1000, maxBuffer: 1 << 26 });
  let res;
  try { res = JSON.parse(r.stdout.trim().split('\n').pop()); }
  catch { res = { engine, status: 'error', error: `no JSON from engine (exit ${r.status}): ${(r.stderr || '').slice(-400)}`, wall_s: null, bytes: 0, requests: null, boundary_events: 0, input_chars: null }; }
  if (r.status !== 0 && res.status === 'ok') { res.status = 'error'; res.error = `exit ${r.status}`; }
  res.exit_code = r.status;
  res.engine = engine;
  res.kind = kind;
  res.run = i;
  res.bytes_on_disk = existsSync(out) ? statSync(out).size : 0;
  res.audio_s = duration(out);
  res.chars_per_min = res.audio_s > 0 && res.input_chars ? Math.round(res.input_chars / (res.audio_s / 60)) : null;
  console.error(`${place} ${engine} ${kind} #${i}: ${res.status} wall=${res.wall_s}s audio=${res.audio_s}s req=${res.requests} events=${res.boundary_events} ${res.error}`);
  return res;
}

const runs = [];
for (const engine of Object.keys(engines)) {
  for (let i = 1; i <= RUNS; i++) runs.push(one(engine, 'episode', i));
  runs.push(one(engine, 'long', 1));
}

const py = spawnSync('uv', ['run', '--quiet', '--with', 'edge-tts', 'python', '-c', 'from importlib.metadata import version;print(version("edge-tts"))'], { encoding: 'utf8' }).stdout.trim();
const env = process.env;
const doc = {
  place,
  generated_at: new Date().toISOString(),
  voice: 'zh-TW-HsiaoChenNeural',
  rate: '-12%',
  node: process.version,
  python_edge_tts: py,
  host: place === 'gha' ? `github-actions ${env.RUNNER_OS ?? ''} ${env.RUNNER_ARCH ?? ''} ${release()}` : `${hostname()} ${platform()} ${arch()} ${release()}`,
  run_url: place === 'gha' && env.GITHUB_RUN_ID ? `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}` : null,
  head_sha: env.GITHUB_SHA ?? null,
  runs,
};
writeFileSync(here(`results/${place}.json`), JSON.stringify(doc, null, 2) + '\n');
console.error(`wrote results/${place}.json`);
