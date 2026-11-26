// Caption-read probe library (T0 spike, agentfleet-team/fisheraiagent#66). Not wired into src/.
import { createHash } from 'node:crypto';

export const sha256 = (s) => createHash('sha256').update(s).digest('hex');

const PLAYER_URL = 'https://www.youtube.com/youtubei/v1/player?prettyPrint=false';
const TIMEOUT_MS = 10000;

// Method table. Each entry is one InnerTube client identity. `fetch-only` means plain fetch(), no dependency.
export const METHODS = {
  'innertube-android': {
    ua: 'com.google.android.youtube/20.10.38 (Linux; U; Android 11) gzip',
    id: 3,
    client: { clientName: 'ANDROID', clientVersion: '20.10.38', androidSdkVersion: 30, osName: 'Android', osVersion: '11' },
  },
  // Same client, a version about a year older: tests how fast a pinned version rots.
  'innertube-android-old': {
    ua: 'com.google.android.youtube/19.09.37 (Linux; U; Android 11) gzip',
    id: 3,
    client: { clientName: 'ANDROID', clientVersion: '19.09.37', androidSdkVersion: 30, osName: 'Android', osVersion: '11' },
  },
  'innertube-android-vr': {
    ua: 'com.google.android.apps.youtube.vr.oculus/1.60.19 (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip',
    id: 28,
    client: { clientName: 'ANDROID_VR', clientVersion: '1.60.19', deviceModel: 'Quest 3', androidSdkVersion: 32, osName: 'Android', osVersion: '12L' },
  },
  'innertube-mweb': {
    ua: 'Mozilla/5.0 (iPad; CPU OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1',
    id: 2,
    client: { clientName: 'MWEB', clientVersion: '2.20250312.01.00' },
  },
  'innertube-web-creator': {
    ua: 'Mozilla/5.0',
    id: 62,
    client: { clientName: 'WEB_CREATOR', clientVersion: '1.20250312.03.01' },
  },
  'innertube-tv': {
    ua: 'Mozilla/5.0 (ChromiumStylePlatform) Cobalt/Version',
    id: 7,
    client: { clientName: 'TVHTML5', clientVersion: '7.20250312.16.00' },
  },
  'innertube-web': {
    ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/131 Safari/537.36',
    id: 1,
    client: { clientName: 'WEB', clientVersion: '2.20250312.04.00' },
  },
};

async function timedFetch(url, init) {
  return fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
}

/** P1 core: one InnerTube player call. Returns { raw, tracks } or throws Error with .code. */
export async function listTracks(method, videoId) {
  const m = METHODS[method];
  if (!m) throw Object.assign(new Error(`unknown method ${method}`), { code: 'method' });
  const res = await timedFetch(PLAYER_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'user-agent': m.ua,
      'x-youtube-client-name': String(m.id),
      'x-youtube-client-version': m.client.clientVersion,
    },
    body: JSON.stringify({ context: { client: { ...m.client, hl: 'en', gl: 'US' } }, videoId, contentCheckOk: true, racyCheckOk: true }),
  });
  const text = await res.text();
  if (!res.ok) throw Object.assign(new Error(`player http ${res.status}`), { code: 'http', body: text.slice(0, 300) });
  let j;
  try {
    j = JSON.parse(text);
  } catch {
    throw Object.assign(new Error('player response is not JSON'), { code: 'parse' });
  }
  const status = j.playabilityStatus?.status;
  if (status !== 'OK') {
    throw Object.assign(new Error(`playability ${status}: ${j.playabilityStatus?.reason ?? ''}`), { code: 'blocked' });
  }
  // Keep only what the reader needs: no streamingData, no visitor data.
  const trimmed = {
    playabilityStatus: { status },
    videoDetails: { videoId: j.videoDetails?.videoId, lengthSeconds: j.videoDetails?.lengthSeconds, title: j.videoDetails?.title },
    captions: j.captions ?? null,
  };
  const r = j.captions?.playerCaptionsTracklistRenderer;
  const tracks = (r?.captionTracks ?? []).map((t, index) => ({
    index,
    languageCode: t.languageCode,
    kind: t.kind === 'asr' ? 'asr' : 'manual',
    vssId: t.vssId,
    name: t.name?.simpleText ?? t.name?.runs?.map((x) => x.text).join('') ?? null,
    isTranslatable: !!t.isTranslatable,
    baseUrl: t.baseUrl,
  }));
  const audioTracks = (r?.audioTracks ?? []).map((a, index) => ({ index, audioTrackId: a.audioTrackId ?? null }));
  return {
    raw: trimmed,
    listing: {
      videoId,
      title: j.videoDetails?.title ?? null,
      durationSeconds: Number(j.videoDetails?.lengthSeconds ?? 0),
      tracks,
      audioTracks,
      defaultAudioTrackIndex: r?.defaultAudioTrackIndex ?? null,
      translationLanguageCount: (r?.translationLanguages ?? []).length,
    },
  };
}

/** P2 core: fetch one track as json3 and parse it into cues. */
export async function fetchTrack(track) {
  const url = new URL(track.baseUrl);
  url.searchParams.set('fmt', 'json3');
  const res = await timedFetch(url, { headers: { 'user-agent': 'Mozilla/5.0' } });
  const body = await res.text();
  if (!res.ok) throw Object.assign(new Error(`timedtext http ${res.status}`), { code: 'http' });
  if (body.length === 0) throw Object.assign(new Error('timedtext empty body'), { code: 'empty' });
  let j;
  try {
    j = JSON.parse(body);
  } catch {
    throw Object.assign(new Error('timedtext is not JSON'), { code: 'parse' });
  }
  return { body, cues: parseJson3(j) };
}

export function parseJson3(j) {
  const cues = [];
  for (const e of j.events ?? []) {
    if (!e.segs) continue;
    const text = e.segs.map((s) => s.utf8 ?? '').join('').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const start = (e.tStartMs ?? 0) / 1000;
    cues.push({ start, end: start + (e.dDurationMs ?? 0) / 1000, text });
  }
  return cues;
}

const primary = (code) => (code ?? '').split('-')[0].toLowerCase();

/**
 * P3 core (pure): which track is the original speech-recognition track?
 * Rule (no language list):
 *  1. Candidates are tracks with kind asr. None -> spoken language unknown.
 *  2. If the player lists several audio tracks (YouTube auto-dubbing), the original audio is the one at
 *     defaultAudioTrackIndex. Its audioTrackId is "<lang>.<n>". The original asr track is the asr track whose
 *     language has the same primary subtag.
 *  3. Otherwise exactly one asr track must exist; it is the original. More than one -> ambiguous.
 */
export function classifyOriginal(listing) {
  const asr = listing.tracks.filter((t) => t.kind === 'asr');
  const out = { videoId: listing.videoId, asrTrackCount: asr.length, spokenLanguage: null, originalAsrTrack: null, manualTrack: null, kind: 'none', rule: null };
  if (asr.length === 0) {
    out.rule = listing.tracks.length ? 'no-asr-track: spoken language unknown, manual tracks ignored' : 'no-tracks';
    return out;
  }
  let original = null;
  if (listing.audioTracks.length > 1 && listing.defaultAudioTrackIndex != null) {
    const a = listing.audioTracks[listing.defaultAudioTrackIndex];
    const lang = primary(a?.audioTrackId?.split('.')[0]);
    original = asr.find((t) => primary(t.languageCode) === lang) ?? null;
    out.rule = `multi-audio: default audio track ${a?.audioTrackId} -> asr track with language ${lang}`;
  } else if (asr.length === 1) {
    original = asr[0];
    out.rule = 'single-asr-track';
  } else {
    out.rule = `ambiguous: ${asr.length} asr tracks and no multi-audio hint`;
  }
  if (!original) return out;
  out.originalAsrTrack = { index: original.index, languageCode: original.languageCode, vssId: original.vssId };
  out.spokenLanguage = original.languageCode;
  const manual = listing.tracks.filter((t) => t.kind === 'manual' && primary(t.languageCode) === primary(original.languageCode));
  const pick = manual.find((t) => t.vssId === `.${t.languageCode}`) ?? manual[0] ?? null;
  if (pick) out.manualTrack = { index: pick.index, languageCode: pick.languageCode, vssId: pick.vssId };
  out.kind = pick ? 'manual' : 'auto';
  return out;
}

const seg = new Intl.Segmenter(undefined, { granularity: 'word' });
export function words(text) {
  const w = [];
  for (const s of seg.segment(text.toLowerCase())) if (s.isWordLike) w.push(s.segment);
  return w;
}

/** P4 core (pure): bag-of-words overlap. F1 = 2*|A∩B| / (|A|+|B|) over multisets; Jaccard over word sets. */
export function compareText(cuesA, cuesB) {
  const wa = words(cuesA.map((c) => c.text).join(' '));
  const wb = words(cuesB.map((c) => c.text).join(' '));
  const ca = new Map();
  for (const w of wa) ca.set(w, (ca.get(w) ?? 0) + 1);
  const cb = new Map();
  for (const w of wb) cb.set(w, (cb.get(w) ?? 0) + 1);
  let inter = 0;
  for (const [w, n] of ca) inter += Math.min(n, cb.get(w) ?? 0);
  const sa = new Set(wa);
  const sb = new Set(wb);
  let si = 0;
  for (const w of sa) if (sb.has(w)) si++;
  const r = (x) => Math.round(x * 1000) / 1000;
  return {
    wordsA: wa.length,
    wordsB: wb.length,
    bagF1: r((2 * inter) / (wa.length + wb.length || 1)),
    setJaccard: r(si / (sa.size + sb.size - si || 1)),
  };
}

export const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
