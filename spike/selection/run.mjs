#!/usr/bin/env node
// Selection spike driver (fisheraiagent#75). Measures whether a keyless YouTube
// search (yt-dlp, no API key) yields enough fresh candidates for three topics,
// per place (mac / gha) and run.
//
// Search: `yt-dlp "<results-url>" --flat-playlist -J` gives the newest-first
// list (sp=EgIQAQ== is YouTube's "sort by upload date"). The ticket named
// `ytsearchdate20:` but that prefix was removed from yt-dlp (checked
// 2026.11.23: YoutubeSearchDateIE no longer exists); the /results URL is the
// same ordering. Full metadata: `yt-dlp -J --skip-download <watch-url>` on the
// top 3 entries per query. Nothing is downloaded.
//
// Usage:
//   node run.mjs --place mac --runs 2 --gap-s 600   # the Mac protocol
//   node run.mjs --place gha --run 7-1              # one cloud run
// Writes results/<place>-<run>.json.
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};
const PLACE = opt('place', null);
const RUNS = Number(opt('runs', 1));
const GAP_S = Number(opt('gap-s', 0));
const TOP_N = Number(opt('top', 3));
const PER_SEARCH = Number(opt('per-search', 20));
const runLabel = opt('run', null); // explicit label for a single run (gha)
if (!PLACE || !['mac', 'gha'].includes(PLACE)) {
  console.error('usage: node run.mjs --place <mac|gha> [--runs N --gap-s S | --run LABEL] [--top 3] [--per-search 20]');
  process.exit(2);
}

const topics = JSON.parse(readFileSync(join(here, 'topics.json'), 'utf8')).topics;
const SEARCH_TIMEOUT_MS = 120_000;
const VIDEO_TIMEOUT_MS = 180_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Fields the ticket asks about on flat search entries.
const FIELD_GROUPS = {
  id: (e) => e.id,
  title: (e) => e.title,
  channel: (e) => e.channel ?? e.uploader,
  upload_date_or_ts: (e) => e.upload_date ?? e.timestamp ?? e.release_timestamp,
  duration: (e) => e.duration,
  view_count: (e) => e.view_count,
};

const ytdlp = (yargs, timeoutMs) => new Promise((resolve) => {
  const t0 = performance.now();
  const p = spawn('uv', ['run', '--with', 'yt-dlp', 'yt-dlp', ...yargs], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = '', killed = false;
  const timer = setTimeout(() => { killed = true; p.kill('SIGTERM'); }, timeoutMs);
  p.stdout.on('data', (d) => { out += d; });
  p.stderr.on('data', (d) => { err += d; });
  p.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, out, err: String(e), wall_s: (performance.now() - t0) / 1000 }); });
  p.on('close', (code) => {
    clearTimeout(timer);
    if (killed && code !== 0) err = `[timeout ${timeoutMs / 1000}s]\n${err}`;
    resolve({ code: code ?? 1, out, err, wall_s: (performance.now() - t0) / 1000 });
  });
});

const errText = (err) => (err || '').trim().split('\n').filter((l) => l.trim() && !l.startsWith(' Downloaded ') && !l.startsWith('Downloading ') && !l.startsWith('Installed ')).slice(-6).join('\n').slice(0, 800);

async function search(query) {
  const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}&sp=EgIQAQ==`;
  const r = await ytdlp([url, '--flat-playlist', '--playlist-end', String(PER_SEARCH), '-J'], SEARCH_TIMEOUT_MS);
  const rec = { url, args: ['--flat-playlist', '--playlist-end', PER_SEARCH, '-J'], status: 'error', exit_code: r.code, wall_s: +r.wall_s.toFixed(2), error: null, result_count: 0, fields_present: {}, entries: [] };
  if (r.code !== 0) { rec.error = errText(r.err) || `exit ${r.code}`; return rec; }
  let doc;
  try { doc = JSON.parse(r.out); } catch (e) { rec.error = `json parse: ${e.message}`; return rec; }
  const entries = (doc.entries || []).filter(Boolean);
  rec.status = 'ok';
  rec.result_count = entries.length;
  for (const [name, get] of Object.entries(FIELD_GROUPS)) {
    rec.fields_present[name] = entries.filter((e) => get(e) != null).length;
  }
  rec.entries = entries.map((e) => ({
    id: e.id ?? null, title: e.title ?? null, duration: e.duration ?? null,
    timestamp: e.timestamp ?? e.release_timestamp ?? null, upload_date: e.upload_date ?? null,
    view_count: e.view_count ?? null, channel: e.channel ?? e.uploader ?? null,
    live_status: e.live_status ?? null,
  }));
  return rec;
}

const capLangs = (block, prefix) => Object.keys(block || {}).filter((k) => k.toLowerCase().startsWith(prefix));

async function videoMeta(id, rank) {
  const url = `https://www.youtube.com/watch?v=${id}`;
  const r = await ytdlp([url, '-J', '--skip-download'], VIDEO_TIMEOUT_MS);
  const rec = { id, rank, url, args: ['-J', '--skip-download'], status: 'error', exit_code: r.code, wall_s: +r.wall_s.toFixed(2), error: null };
  if (r.code !== 0) { rec.error = errText(r.err) || `exit ${r.code}`; return rec; }
  let d;
  try { d = JSON.parse(r.out); } catch (e) { rec.error = `json parse: ${e.message}`; return rec; }
  const subs = d.subtitles || {}, auto = d.automatic_captions || {};
  rec.status = 'ok';
  rec.upload_date = d.upload_date ?? null;
  rec.timestamp = d.timestamp ?? null;
  rec.duration = d.duration ?? null;
  rec.view_count = d.view_count ?? null;
  rec.channel = d.channel ?? d.uploader ?? null;
  rec.channel_follower_count = d.channel_follower_count ?? null;
  rec.captions = {
    subtitles: { zh: capLangs(subs, 'zh'), en: capLangs(subs, 'en') },
    automatic_captions: { zh: capLangs(auto, 'zh'), en: capLangs(auto, 'en') },
  };
  rec.captions.has_zh = rec.captions.subtitles.zh.length + rec.captions.automatic_captions.zh.length > 0;
  rec.captions.has_en = rec.captions.subtitles.en.length + rec.captions.automatic_captions.en.length > 0;
  return rec;
}

async function oneRun(label) {
  const doc = {
    tool: `yt-dlp ${(await ytdlp(['--version'], 60_000)).out.trim()} via 'uv run --with yt-dlp yt-dlp'`,
    place: PLACE, run: label, started_at: new Date().toISOString(),
    per_search: PER_SEARCH, top_n: TOP_N,
    queries: [],
  };
  for (const topic of topics) {
    for (const query of topic.queries) {
      const q = { topic_id: topic.id, query, search: null, videos: [] };
      q.search = await search(query);
      console.log(`[${label}] ${topic.id} "${query}" search ${q.search.status} ${q.search.result_count} hits ${q.search.wall_s}s${q.search.error ? ' ERR ' + q.search.error.split('\n')[0] : ''}`);
      const top = q.search.entries.slice(0, TOP_N).filter((e) => e.id);
      for (let i = 0; i < top.length; i++) {
        const v = await videoMeta(top[i].id, i + 1);
        q.videos.push(v);
        console.log(`[${label}]   #${i + 1} ${v.id} ${v.status} ${v.wall_s}s up=${v.upload_date ?? '-'} dur=${v.duration ?? '-'}${v.error ? ' ERR ' + v.error.split('\n')[0] : ''}`);
      }
      doc.queries.push(q);
    }
  }
  const file = join(here, 'results', `${PLACE}-${label}.json`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(doc, null, 2) + '\n');
  console.log(`wrote ${file}`);
}

if (runLabel) {
  await oneRun(String(runLabel));
} else {
  for (let i = 1; i <= RUNS; i++) {
    await oneRun(String(i));
    if (i < RUNS && GAP_S > 0) {
      console.log(`gap: sleeping ${GAP_S}s before next run`);
      await sleep(GAP_S * 1000);
    }
  }
}
