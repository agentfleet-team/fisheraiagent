#!/usr/bin/env node
// Selection spike driver (fisheraiagent#75). Measures whether a keyless YouTube
// search (yt-dlp, no API key) yields enough fresh candidates for three topics,
// per place (mac / gha) and run.
//
// Search: two filtered searches per query, both upload-date sort + type video +
// an upload-date filter, the same parameters allen-ai-os#1878 RFC-003 uses:
//   week:  /results?search_query=<q>&sp=CAISBAgDEAE%3D
//   month: /results?search_query=<q>&sp=CAISBAgEEAE%3D
// Each search is measured through `yt-dlp --flat-playlist -J` (the keyless
// search call) and through one read of the same results page, from whose
// ytInitialData (videoRenderer / lockupViewModel entries) the relative age
// text ("3d ago") and the CC badge are taken. No per-video call is needed for
// those two fields. Full metadata: `yt-dlp -J --skip-download <watch-url>` on
// the top 3 deduplicated candidates per query (week hits first). Nothing is
// downloaded.
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
const PAGE_TIMEOUT_MS = 60_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The two search parameters: upload-date sort + type video + upload-date
// filter. Literal text stays here so the ticket oracle can decode each param.
const SEARCHES = [
  { filter: 'week', param: 'sp=CAISBAgDEAE%3D' },
  { filter: 'month', param: 'sp=CAISBAgEEAE%3D' },
];

// Fields the ticket asks about on flat search entries, plus the page fields.
const FIELD_GROUPS = {
  id: (e) => e.id,
  title: (e) => e.title,
  channel: (e) => e.channel ?? e.uploader,
  upload_date_or_ts: (e) => e.upload_date ?? e.timestamp ?? e.release_timestamp,
  duration: (e) => e.duration,
  view_count: (e) => e.view_count,
  age_text: (e) => e.age_text,
  cc_badge: (e) => (e.cc_badge === true ? 1 : null),
};

const PAGE_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Accept-Language': 'en-US,en;q=0.9',
  Cookie: 'CONSENT=YES+cb',
};
const AGE_RE = /\bago\b|^Streamed\b|^Premiered\b|^Scheduled\b|^Upcoming\b/i;
const DUR_RE = /^\d{1,3}:\d{2}(:\d{2})?$/;

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

// --- ytInitialData page read ---------------------------------------------

// Locate "ytInitialData = {...}" and brace-match it (string-aware).
function extractInitialData(html) {
  const re = /ytInitialData\s*=\s*\{/g;
  let m;
  while ((m = re.exec(html))) {
    const start = m.index + m[0].length - 1;
    let depth = 0, inStr = false, esc = false, end = -1;
    for (let i = start; i < html.length; i++) {
      const c = html[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
      } else if (c === '"') inStr = true;
      else if (c === '{') depth++;
      else if (c === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
    }
    if (end < 0) continue;
    try {
      const d = JSON.parse(html.slice(start, end));
      if (d && typeof d === 'object') return d;
    } catch { /* try next assignment */ }
  }
  return null;
}

const leafStrings = (o, acc = []) => {
  if (o == null) return acc;
  if (typeof o === 'string') { acc.push(o); return acc; }
  if (typeof o !== 'object') return acc;
  for (const v of Object.values(o)) leafStrings(v, acc);
  return acc;
};

const durTextToSec = (t) => {
  const parts = t.split(':').map(Number);
  return parts.reduce((s, n) => s * 60 + n, 0);
};

// One rendered search entry -> {id, age_text, cc_badge, duration, title, channel}.
function parsePageEntry(r, kind) {
  const json = JSON.stringify(r);
  const cc_badge = /"label"\s*:\s*"CC"/.test(json);
  if (kind === 'videoRenderer') {
    const age = r.publishedTimeText?.simpleText
      ?? leafStrings(r.publishedTimeText)[0]
      ?? leafStrings(r).find((s) => AGE_RE.test(s))
      ?? null;
    const dur = r.lengthText?.simpleText ?? leafStrings(r).find((s) => DUR_RE.test(s)) ?? null;
    return {
      id: r.videoId ?? null,
      title: r.title?.runs?.map((x) => x.text).join('') ?? r.title?.simpleText ?? null,
      channel: r.ownerText?.runs?.[0]?.text ?? r.shortBylineText?.runs?.[0]?.text ?? null,
      duration: dur && DUR_RE.test(dur) ? durTextToSec(dur) : null,
      age_text: age,
      cc_badge,
    };
  }
  // lockupViewModel
  const strings = leafStrings(r);
  const age = strings.find((s) => AGE_RE.test(s)) ?? null;
  const dur = strings.find((s) => DUR_RE.test(s)) ?? null;
  return {
    id: r.contentId ?? null,
    title: r.metadata?.lockupMetadataViewModel?.title?.content ?? null,
    channel: null,
    duration: dur ? durTextToSec(dur) : null,
    age_text: age,
    cc_badge,
  };
}

// Collect videoRenderer / lockupViewModel entries in document order.
function pageEntries(data) {
  const out = [];
  const walk = (o) => {
    if (!o || typeof o !== 'object') return;
    if (Array.isArray(o)) { for (const v of o) walk(v); return; }
    for (const [k, v] of Object.entries(o)) {
      if (k === 'videoRenderer') out.push(parsePageEntry(v, k));
      else if (k === 'lockupViewModel') out.push(parsePageEntry(v, k));
      else walk(v);
    }
  };
  walk(data.contents ?? data);
  return out;
}

async function fetchPage(url) {
  const t0 = performance.now();
  const rec = { status: 'error', http_status: null, wall_s: 0, error: null, entry_count: 0, entries: [] };
  try {
    let resp;
    for (let attempt = 0; attempt < 3; attempt++) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), PAGE_TIMEOUT_MS);
      try { resp = await fetch(url, { headers: PAGE_HEADERS, signal: ctrl.signal, redirect: 'follow' }); }
      catch (e) {
        clearTimeout(timer);
        if (attempt < 2 && e.name !== 'AbortError') { await sleep(1500 * (attempt + 1)); continue; }
        throw e;
      }
      clearTimeout(timer);
      break;
    }
    rec.http_status = resp.status;
    const html = await resp.text();
    rec.wall_s = +((performance.now() - t0) / 1000).toFixed(2);
    if (!resp.ok) { rec.error = `HTTP ${resp.status}`; return rec; }
    const data = extractInitialData(html);
    if (!data) { rec.error = 'no ytInitialData in page'; return rec; }
    rec.entries = pageEntries(data).filter((e) => e.id);
    rec.entry_count = rec.entries.length;
    rec.status = 'ok';
    return rec;
  } catch (e) {
    rec.wall_s = +((performance.now() - t0) / 1000).toFixed(2);
    rec.error = e.name === 'AbortError' ? `timeout ${PAGE_TIMEOUT_MS / 1000}s` : String(e.message || e);
    return rec;
  }
}

// --- searches --------------------------------------------------------------

async function search(query, { filter, param }) {
  const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}&${param}`;
  const rec = {
    filter, url, args: ['--flat-playlist', '--playlist-end', PER_SEARCH, '-J'],
    status: 'error', exit_code: null, wall_s: null, error: null,
    page: null, result_count: 0, fields_present: {}, entries: [],
  };
  const [r, page] = await Promise.all([
    ytdlp([url, '--flat-playlist', '--playlist-end', String(PER_SEARCH), '-J'], SEARCH_TIMEOUT_MS),
    fetchPage(url),
  ]);
  rec.page = { ...page, entries: page.entries.map((e) => ({ id: e.id, age_text: e.age_text, cc_badge: e.cc_badge, duration: e.duration })) };
  const pageById = new Map(page.entries.map((e) => [e.id, e]));

  rec.exit_code = r.code;
  rec.wall_s = +r.wall_s.toFixed(2);
  if (r.code === 0) {
    try {
      const doc = JSON.parse(r.out);
      const entries = (doc.entries || []).filter(Boolean);
      rec.status = 'ok';
      rec.result_count = entries.length;
      rec.entries = entries.map((e) => ({
        id: e.id ?? null, title: e.title ?? null, duration: e.duration ?? null,
        timestamp: e.timestamp ?? e.release_timestamp ?? null, upload_date: e.upload_date ?? null,
        view_count: e.view_count ?? null, channel: e.channel ?? e.uploader ?? null,
        live_status: e.live_status ?? null,
        age_text: pageById.get(e.id)?.age_text ?? null,
        cc_badge: pageById.get(e.id)?.cc_badge ?? null,
      }));
    } catch (e) {
      rec.status = 'error';
      rec.error = `json parse: ${e.message}`;
    }
  } else {
    rec.error = errText(r.err) || `exit ${r.code}`;
    // Fall back to page entries so the supply count still works if yt-dlp
    // fails but the page read succeeded.
    if (page.status === 'ok') {
      rec.entries = page.entries.map((e) => ({
        id: e.id, title: e.title, duration: e.duration,
        timestamp: null, upload_date: null, view_count: null, channel: e.channel,
        live_status: null, age_text: e.age_text, cc_badge: e.cc_badge, source: 'page',
      }));
      rec.result_count = rec.entries.length;
    }
  }
  for (const [name, get] of Object.entries(FIELD_GROUPS)) {
    rec.fields_present[name] = rec.entries.filter((e) => get(e) != null).length;
  }
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
    search_filters: SEARCHES.map((s) => s.filter),
    queries: [],
  };
  for (const topic of topics) {
    for (const query of topic.queries) {
      const q = { topic_id: topic.id, query, searches: [], videos: [] };
      for (const s of SEARCHES) {
        const rec = await search(query, s);
        q.searches.push(rec);
        console.log(`[${label}] ${topic.id} "${query}" ${s.filter} search ${rec.status} ${rec.result_count} hits ${rec.wall_s}s page=${rec.page.status}:${rec.page.entry_count}${rec.error ? ' ERR ' + rec.error.split('\n')[0] : ''}`);
      }
      // Top-3 probe on the deduplicated candidate list, week hits first.
      const seen = new Set();
      const cands = [];
      for (const s of q.searches) {
        for (const e of s.entries) {
          if (e.id && !seen.has(e.id)) { seen.add(e.id); cands.push(e); }
        }
      }
      const top = cands.slice(0, TOP_N);
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
