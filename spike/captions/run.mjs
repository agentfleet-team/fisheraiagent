#!/usr/bin/env node
// Driver for P1-P5. Usage: node run.mjs <method> <videoId>... [--runs 3]
// Writes out/<method>/<videoId>/{tracks,spoken,cues,timing}.json and out/compare/<videoId>.json.
// Fixtures (raw player and timedtext responses) go to fixtures/<method>/<videoId>/.
// Order: P1 list-tracks, P3 classify-original (pure, picks the tracks), P2 fetch-track, P4 compare-text, P5 timing.
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listTracks, fetchTrack, classifyOriginal, compareText, median, sha256 } from './lib.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const ri = args.indexOf('--runs');
const RUNS = ri >= 0 ? Number(args.splice(ri, 2)[1]) : 3;
const [method, ...videoIds] = args;
if (!method || videoIds.length === 0) {
  console.error('usage: node run.mjs <method> <videoId>... [--runs 3]');
  process.exit(2);
}

const put = (rel, data) => {
  const p = join(here, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, typeof data === 'string' ? data : JSON.stringify(data, null, 2) + '\n');
};
const ms = (t0) => Math.round(performance.now() - t0);

async function one(videoId) {
  const dir = `out/${method}/${videoId}`;
  const fx = `fixtures/${method}/${videoId}`;
  const timing = { method, videoId, runs: [] };
  let listing, spoken, chosen = {};
  for (let run = 0; run < RUNS; run++) {
    const r = { p1Ms: null, p2Ms: null, error: null };
    try {
      let t = performance.now();
      const l = await listTracks(method, videoId);
      r.p1Ms = ms(t);
      if (run === 0) {
        listing = l.listing;
        put(`${fx}/player.json`, l.raw);
        // Never persist signed URLs' expiry-bound query beyond what the fixture needs: keep as returned.
        put(`${dir}/tracks.json`, { ...l.listing, tracks: l.listing.tracks.map(({ baseUrl, ...t2 }) => t2) });
        console.log(`P1 ${method} ${videoId} ${l.listing.tracks.length} tracks ${r.p1Ms}ms`);
        spoken = classifyOriginal(l.listing);
        put(`${dir}/spoken.json`, { ...spoken, tracksSha256: sha256(JSON.stringify(l.listing.tracks.map(({ baseUrl, ...t2 }) => t2))) });
        console.log(`P3 ${method} ${videoId} kind=${spoken.kind} spoken=${spoken.spokenLanguage} (${spoken.rule})`);
      }
      // P2: fetch the original asr track and the same-language manual track when present.
      const wanted = [];
      if (spoken.originalAsrTrack) wanted.push(['asr', spoken.originalAsrTrack.index]);
      if (spoken.manualTrack) wanted.push(['manual', spoken.manualTrack.index]);
      // Control: one asr track that is NOT the original, to show what a translated/dubbed track looks like.
      const other = l.listing.tracks.find((t2) => t2.kind === 'asr' && t2.index !== spoken.originalAsrTrack?.index);
      if (other && spoken.originalAsrTrack) wanted.push(['asr-other', other.index]);
      t = performance.now();
      for (const [label, index] of wanted) {
        const track = l.listing.tracks[index];
        const f = await fetchTrack(track);
        if (run === 0) {
          put(`${fx}/${label}.${track.languageCode}.json3`, f.body);
          chosen[label] = { index, languageCode: track.languageCode, vssId: track.vssId, bytes: f.body.length, cueCount: f.cues.length, first3: f.cues.slice(0, 3), cues: f.cues };
        }
      }
      r.p2Ms = ms(t);
      if (run === 0) {
        const summary = Object.fromEntries(Object.entries(chosen).map(([k, v]) => [k, { ...v, cues: undefined }]));
        put(`${dir}/cues.json`, Object.fromEntries(Object.entries(chosen)));
        console.log(`P2 ${method} ${videoId} ${Object.entries(summary).map(([k, v]) => `${k}:${v.cueCount} cues`).join(' ') || '0 tracks fetched'} ${r.p2Ms}ms`);
      }
    } catch (e) {
      r.error = `${e.code ?? 'error'}: ${e.message}`;
      if (run === 0) {
        put(`${dir}/error.json`, { method, videoId, code: e.code ?? 'error', message: e.message, body: e.body ?? null });
        console.log(`P1 ${method} ${videoId} ERROR ${r.error}`);
      }
    }
    timing.runs.push(r);
  }
  const ok = timing.runs.filter((r) => !r.error);
  timing.okRuns = ok.length;
  timing.medianP1Ms = ok.length ? median(ok.map((r) => r.p1Ms)) : null;
  timing.medianP2Ms = ok.length ? median(ok.map((r) => r.p2Ms)) : null;
  timing.medianTotalMs = ok.length ? median(ok.map((r) => r.p1Ms + r.p2Ms)) : null;
  put(`${dir}/timing.json`, timing);
  console.log(`P5 ${method} ${videoId} median total ${timing.medianTotalMs}ms over ${ok.length}/${RUNS} ok runs`);

  // P4: ASR vs manual of the same video, both in the spoken language.
  if (chosen.asr && chosen.manual) {
    const cmp = {
      videoId,
      method: 'bag-of-words over Intl.Segmenter word segments, lower-cased; bagF1 = 2*|A∩B|/(|A|+|B|) on multisets; setJaccard on word sets',
      a: { label: 'asr', language: chosen.asr.languageCode, cues: chosen.asr.cueCount },
      b: { label: 'manual', language: chosen.manual.languageCode, cues: chosen.manual.cueCount },
      ...compareText(chosen.asr.cues, chosen.manual.cues),
      inputSha256: { asr: sha256(JSON.stringify(chosen.asr.cues)), manual: sha256(JSON.stringify(chosen.manual.cues)) },
    };
    put(`out/compare/${method}/${videoId}.json`, cmp);
    console.log(`P4 ${videoId} asr-vs-manual bagF1=${cmp.bagF1} setJaccard=${cmp.setJaccard}`);
  }
}

for (const v of videoIds) await one(v);
