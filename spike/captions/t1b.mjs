#!/usr/bin/env node
// T1b probe (agentfleet-team/fisheraiagent#79). Read-only: one InnerTube player call per (video, hl).
// Usage: node t1b.mjs <videoId>... [--hl en,zh-TW]   (no ids: use the ids in t1b-videos.json)
// Writes fixtures/t1b/<hl>/<videoId>.player.json (captions block only, no signed URLs) and out/t1b/<hl>/<videoId>.json.
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { METHODS } from './lib.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const hi = args.indexOf('--hl');
const HLS = hi >= 0 ? args.splice(hi, 2)[1].split(',') : ['en', 'zh-TW'];
const videos = JSON.parse(readFileSync(join(here, 't1b-videos.json'), 'utf8'));
const ids = args.length ? args : videos.map((v) => v.videoId);
const m = METHODS['innertube-android'];
const put = (rel, data) => {
  const p = join(here, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(data, null, 2) + '\n');
};

async function player(videoId, hl) {
  const res = await fetch('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
    method: 'POST',
    signal: AbortSignal.timeout(15000),
    headers: { 'content-type': 'application/json', 'user-agent': m.ua, 'x-youtube-client-name': String(m.id), 'x-youtube-client-version': m.client.clientVersion },
    body: JSON.stringify({ context: { client: { ...m.client, hl, gl: 'US' } }, videoId, contentCheckOk: true, racyCheckOk: true }),
  });
  return res.json();
}

for (const hl of HLS) for (const videoId of ids) {
  let j;
  try { j = await player(videoId, hl); } catch (e) { j = { error: String(e.message) }; }
  const r = j.captions?.playerCaptionsTracklistRenderer;
  const tracks = (r?.captionTracks ?? []).map((t, index) => ({
    index, languageCode: t.languageCode, kind: t.kind === 'asr' ? 'asr' : 'manual', vssId: t.vssId,
    name: t.name?.simpleText ?? t.name?.runs?.map((x) => x.text).join('') ?? null,
  }));
  const audio = (r?.audioTracks ?? []).map((a, index) => ({ index, audioTrackId: a.audioTrackId ?? null, captionTrackIndices: a.captionTrackIndices ?? null, defaultCaptionTrackIndex: a.defaultCaptionTrackIndex ?? null }));
  const dai = r?.defaultAudioTrackIndex ?? null;
  const indices = dai != null ? audio[dai]?.captionTrackIndices ?? null : null;
  const named = indices ? indices.map((i) => tracks[i] ?? null) : null;
  const rec = {
    videoId, hl, status: j.playabilityStatus?.status ?? j.error ?? 'unknown', title: j.videoDetails?.title ?? null,
    tracks, audioTracks: audio, defaultAudioTrackIndex: dai,
    captionTrackIndices: indices, named,
    hasAsr: tracks.some((t) => t.kind === 'asr'),
  };
  put(`out/t1b/${hl}/${videoId}.json`, rec);
  put(`fixtures/t1b/${hl}/${videoId}.player.json`, { videoId, hl, status: rec.status, title: rec.title, audioTracks: r?.audioTracks ?? null, defaultAudioTrackIndex: dai, captionTracks: (r?.captionTracks ?? []).map(({ baseUrl, ...t }) => t) });
  console.log(`${hl} ${videoId} status=${rec.status} tracks=${tracks.map((t) => `${t.kind[0]}:${t.languageCode}`).join(',')} idx=${JSON.stringify(indices)}`);
}
