// Generates REPORT.md from results/*.json. usage: node report.mjs
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const here = (p) => new URL(p, import.meta.url).pathname;
const places = ['mac', 'gha'];
const docs = Object.fromEntries(places.filter((p) => existsSync(here(`results/${p}.json`))).map((p) => [p, JSON.parse(readFileSync(here(`results/${p}.json`), 'utf8'))]));
const engineOrder = ['python-edge-tts', 'node-msedge-tts', 'node-edge-tts-universal'];
const med = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null; };
const f = (v) => (v === null || v === undefined ? '-' : String(v));
const rows = [];
for (const place of places) for (const r of docs[place]?.runs ?? []) rows.push({ place, ...r });
const sel = (e, p, kind) => rows.filter((r) => r.engine === e && r.place === p && r.kind === kind);

const out = [];
out.push('# Spike: Edge TTS zh-TW 曉臻 -12%, 10-minute render, Mac and cloud (fisheraiagent#74)');
out.push('');
out.push('Rerun the Mac numbers with one command: `cd spike/tts && npm ci && npm run mac` (needs Node >= 22, `uv`, network to the Edge TTS endpoint; it runs `run.mjs mac` then regenerates this file with `node report.mjs`). Cloud numbers come from the `spike-tts` workflow (re-run it with `workflow_dispatch` or push to this PR), then `node report.mjs` after downloading its artifact into `results/`.');
out.push('');
out.push(`Voice \`zh-TW-HsiaoChenNeural\`, rate \`-12%\`, output 24 kHz 48 kbit mono MP3. Fixture \`fixture/episode-zh-tw.txt\` (${rows.find((r) => r.kind === 'episode')?.input_chars ?? '?'} chars). Wall s is the synthesis time inside the engine process (excludes \`uv\` start-up). Audio s is read with \`mutagen\`. Chars/min = input chars / audio minutes.`);
out.push('');
for (const p of places) {
  const d = docs[p];
  if (!d) { out.push(`- **${p}**: no results file yet.`); continue; }
  out.push(`- **${p}**: ${d.host}; node ${d.node}; python edge-tts ${d.python_edge_tts}; generated ${d.generated_at}${d.run_url ? `; workflow run ${d.run_url}` : ''}`);
}
out.push('');
out.push('## Results');
out.push('');
out.push('| engine | place | run | wall s | status | bytes | audio s | chars/min | requests | boundary events (type) |');
out.push('|---|---|---|---|---|---|---|---|---|---|');
for (const e of engineOrder) for (const p of places) for (const r of rows.filter((x) => x.engine === e && x.place === p)) {
  const run = r.kind === 'long' ? `20k chars (${r.input_chars})` : r.run;
  out.push(`| ${e}${e === 'python-edge-tts' ? ' ' + (docs[p]?.python_edge_tts ?? '') : ''}${r.engine_version && e !== 'python-edge-tts' ? ' ' + r.engine_version : ''} | ${p} | ${run} | ${f(r.wall_s)} | ${r.status}${r.exit_code ? ` (exit ${r.exit_code})` : ''} | ${f(r.bytes_on_disk)} | ${f(r.audio_s)} | ${f(r.chars_per_min)} | ${f(r.requests)} | ${r.boundary_events} (${f(r.boundary_type)}) |`);
}
out.push('');
out.push('## Errors seen');
out.push('');
const errs = new Map();
for (const r of rows) if (r.error) { const k = `${r.engine} / ${r.place} / ${r.kind}`; errs.set(k, (errs.get(k) ?? new Set()).add(r.error)); }
if (!errs.size) out.push('None.');
for (const [k, v] of errs) for (const m of v) out.push(`- ${k}: \`${m.replace(/`/g, "'").slice(0, 300)}\``);
out.push('');
out.push('## 20,000-character behavior');
out.push('');
const okRuns = rows.filter((r) => r.kind === 'episode' && r.status === 'ok' && r.audio_s > 0);
const cpm = med(okRuns.map((r) => r.chars_per_min));
out.push('| engine | place | outcome | audio s | expected audio s | audio / expected | boundary text chars / input chars | requests | wall s |');
out.push('|---|---|---|---|---|---|---|---|---|');
for (const e of engineOrder) for (const p of places) for (const r of sel(e, p, 'long')) {
  const exp = cpm ? Math.round((r.input_chars / cpm) * 60) : null;
  const ratio = exp && r.audio_s ? (r.audio_s / exp) : null;
  const outcome = r.status === 'error' && !r.audio_s ? `error: ${r.error.slice(0, 120)}` : ratio !== null && ratio < 0.95 ? (r.status === 'error' ? `partial audio then error: ${r.error.slice(0, 120)}` : 'silent truncation') : r.status === 'error' ? `full audio, then error: ${r.error.slice(0, 120)}` : 'full output';
  out.push(`| ${e} | ${p} | ${outcome} | ${f(r.audio_s)} | ${f(exp)} | ${ratio === null ? '-' : ratio.toFixed(2)} | ${r.boundary_text_chars}/${r.input_chars} | ${f(r.requests)} | ${f(r.wall_s)} |`);
}
out.push('');
out.push('Expected audio s = input chars / median chars-per-minute of all successful 10-minute-fixture runs. A ratio under 0.95 with status ok means silent truncation.');
out.push('');
out.push('## Findings for RFC-4');
out.push('');
out.push('Numbers below are computed from `results/*.json`.');
out.push('');
const cpmByEngine = (e) => med(okRuns.filter((r) => r.engine === e).map((r) => r.chars_per_min));
out.push(`- Characters for a 10-minute episode at -12%: about ${cpm ? Math.round(cpm * 10) : '?'} (median ${f(cpm)} chars/min over ${okRuns.length} successful runs; per engine: ${engineOrder.map((e) => `${e} ${f(cpmByEngine(e))}`).join(', ')}).`);
for (const e of engineOrder) {
  const parts = places.filter((p) => docs[p]).map((p) => { const rs = sel(e, p, 'episode'); return `${p} ${rs.filter((r) => r.status === 'ok').length}/${rs.length}`; });
  const w = med(rows.filter((r) => r.engine === e && r.place === 'gha' && r.kind === 'episode' && r.status === 'ok').map((r) => r.wall_s));
  out.push(`- Reliability, ${e}: ${parts.join(', ')} successful 10-minute runs${w ? `; cloud median wall ${w} s` : ''}.`);
}
for (const e of engineOrder) {
  const r = rows.find((x) => x.engine === e && x.kind === 'episode' && x.status === 'ok');
  const ev = r ? `${r.boundary_type}, median ${med(rows.filter((x) => x.engine === e && x.kind === 'episode' && x.status === 'ok').map((x) => x.boundary_events))} events per episode` : 'no successful run';
  out.push(`- Timing stream, ${e}: ${ev}.`);
}
const maxOk = (e) => Math.max(0, ...rows.filter((r) => r.engine === e && r.kind === 'episode' && r.status === 'ok').map((r) => r.input_chars / Math.max(1, r.requests ?? 1)));
out.push(`- Largest characters per request seen succeeding: ${engineOrder.map((e) => `${e} ${Math.round(maxOk(e))}`).join(', ')} (python and universal split at 4096 UTF-8 bytes, about 1365 CJK chars; msedge-tts does not split).`);
out.push('');
if (existsSync(here('recommendation.md'))) { out.push('### Recommendation'); out.push(''); out.push(readFileSync(here('recommendation.md'), 'utf8').trim()); out.push(''); }
writeFileSync(here('REPORT.md'), out.join('\n'));
console.error('wrote REPORT.md');
