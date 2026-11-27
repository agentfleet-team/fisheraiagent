// Renders A/B samples of one zh-TW sentence with English spans (agentfleet-team/fisheraiagent#107).
// usage: npm ci && node render.mjs   (network to the Edge TTS endpoint; no secrets)
// Step 1 sends each option as one SSML request, exactly as the ticket names it.
// Step 2, only for an option that Edge rejects: one request per span with plain
// text (the only shape Edge accepts), then the MP3 frames are concatenated.
import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts';
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';

const VOICE = 'zh-TW-HsiaoChenNeural';
const RATE = '-12%'; // RFC-004 base rate
const EN_VOICE = 'en-US-AriaNeural'; // English voice for the split fallback of option 2
const SLOW_RATE = '-35%'; // rate on Latin spans for option 3
const SENTENCE = '今天第一則是 Matt Pocock 示範怎麼用 mattpocock/skills 在一天內交付兩萬一千行的功能。';
const LATIN = /[A-Za-z][A-Za-z0-9./_-]*(?: [A-Za-z][A-Za-z0-9./_-]*)*/g;
const pkgVersion = JSON.parse(readFileSync(new URL('./node_modules/msedge-tts/package.json', import.meta.url), 'utf8')).version;

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const wrapLatin = (tag) => esc(SENTENCE).replace(LATIN, (m) => tag(m));

// Same template as msedge-tts 2.1.1 _SSMLTemplate (dist/MsEdgeTTS.js), one line.
const ssml = (inner, rate = RATE) =>
  `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="https://www.w3.org/2001/mstts" xml:lang="zh-TW"><voice name="${VOICE}"><prosody pitch="+0Hz" rate="${rate}" volume="+0%">${inner}</prosody></voice></speak>`;

// Splits the sentence into [{text, latin}] spans, trimmed, non-empty.
function spans() {
  const out = [];
  let last = 0;
  for (const m of SENTENCE.matchAll(LATIN)) {
    out.push({ text: SENTENCE.slice(last, m.index), latin: false });
    out.push({ text: m[0], latin: true });
    last = m.index + m[0].length;
  }
  out.push({ text: SENTENCE.slice(last), latin: false });
  return out.map((s) => ({ ...s, text: s.text.trim() })).filter((s) => s.text);
}

async function synth(voice, requestSsml) {
  const tts = new MsEdgeTTS({ synthesisTimeoutMs: 30000 });
  try {
    await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
    const { audioStream } = tts.rawToStream(requestSsml);
    const parts = [];
    await new Promise((res, rej) => {
      audioStream.on('data', (d) => parts.push(d));
      audioStream.on('error', rej);
      audioStream.on('close', res);
    });
    const buf = Buffer.concat(parts);
    if (buf.length === 0) throw new Error('empty audio');
    return buf;
  } finally {
    tts.close();
  }
}

const enSsml = (text, rate) =>
  `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="https://www.w3.org/2001/mstts" xml:lang="en-US"><voice name="${EN_VOICE}"><prosody pitch="+0Hz" rate="${rate}" volume="+0%">${esc(text)}</prosody></voice></speak>`;

const options = [
  { id: 'as-is', n: 1, single: ssml(esc(SENTENCE)) },
  {
    id: 'lang', n: 2,
    single: ssml(wrapLatin((m) => `<lang xml:lang="en-US">${m}</lang>`)),
    split: (s) => (s.latin ? { voice: EN_VOICE, ssml: enSsml(s.text, RATE) } : { voice: VOICE, ssml: ssml(esc(s.text)) }),
  },
  {
    id: 'slow', n: 3,
    single: ssml(wrapLatin((m) => `<prosody rate="${SLOW_RATE}">${m}</prosody>`)),
    split: (s) => ({ voice: VOICE, ssml: ssml(esc(s.text), s.latin ? SLOW_RATE : RATE) }),
  },
];

const dir = new URL('./samples/', import.meta.url);
mkdirSync(dir, { recursive: true });
const results = [];
for (const o of options) {
  const r = { id: o.id, single: { ssml: o.single, status: 'ok', error: '' } };
  try {
    const buf = await synth(VOICE, o.single);
    r.file = `sample-${o.n}-${o.id}.mp3`;
    writeFileSync(new URL(r.file, dir), buf);
    r.method = 'single-ssml';
  } catch (e) {
    r.single.status = 'rejected';
    r.single.error = String(e?.message ?? e);
  }
  if (r.single.status === 'rejected' && o.split) {
    r.split = { requests: [], status: 'ok', error: '' };
    try {
      const bufs = [];
      for (const s of spans()) {
        const q = o.split(s);
        r.split.requests.push(q);
        bufs.push(await synth(q.voice, q.ssml));
      }
      r.file = `sample-${o.n}-${o.id}-split.mp3`;
      writeFileSync(new URL(r.file, dir), Buffer.concat(bufs));
      r.method = 'split-requests';
    } catch (e) {
      r.split.status = 'rejected';
      r.split.error = String(e?.message ?? e);
    }
  }
  results.push(r);
  console.log(JSON.stringify({ id: r.id, single: r.single.status, method: r.method ?? 'none', file: r.file ?? '' }));
}
writeFileSync(
  new URL('results.json', dir),
  JSON.stringify({ msedge_tts: pkgVersion, node: process.version, generated_at: new Date().toISOString(), voice: VOICE, rate: RATE, en_voice: EN_VOICE, slow_rate: SLOW_RATE, sentence: SENTENCE, results }, null, 2) + '\n',
);
