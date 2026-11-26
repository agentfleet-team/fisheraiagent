// Edge TTS Node engines. One synthesis, one JSON line on stdout.
// usage: node engine_node.mjs <msedge-tts|edge-tts-universal> <text-file> <out.mp3> [--repeat-to N]
import { readFileSync, writeFileSync } from 'node:fs';

const VOICE = 'zh-TW-HsiaoChenNeural';
const RATE = '-12%';
const [lib, file, out, ...rest] = process.argv.slice(2);
const pkg = JSON.parse(readFileSync(new URL(`./node_modules/${lib}/package.json`, import.meta.url), 'utf8'));

let text = readFileSync(file, 'utf8').trim();
const ri = rest.indexOf('--repeat-to');
if (ri >= 0) {
  const n = Number(rest[ri + 1]);
  const unit = text + '\n';
  text = unit.repeat(Math.floor(n / unit.length) + 1).slice(0, n);
}

const res = {
  engine: `node-${lib}`,
  engine_version: pkg.version,
  input_chars: [...text].length,
  requests: null,
  boundary_type: null,
  boundary_events: 0,
  boundary_text_chars: 0,
  bytes: 0,
  status: 'ok',
  error: '',
};
const t0 = performance.now();
const parts = [];
let finished = false;

function finish() {
  if (finished) return;
  finished = true;
  if (parts.length) writeFileSync(out, Buffer.concat(parts));
  res.wall_s = Math.round((performance.now() - t0) / 10) / 100;
  console.log(JSON.stringify(res));
}

// edge-tts-universal 1.4.0 never settles when the websocket handshake fails: the event loop
// drains and Node exits with a pending await. Report that as an error instead of a silent exit.
process.on('beforeExit', () => {
  if (!finished) {
    res.status = 'error';
    res.error = 'event loop drained before the stream finished (library swallowed a websocket handshake error)';
    finish();
  }
});

async function viaMsedge() {
  const { MsEdgeTTS, OUTPUT_FORMAT } = await import('msedge-tts');
  const tts = new MsEdgeTTS({ synthesisTimeoutMs: 20 * 60 * 1000 });
  await tts.setMetadata(VOICE, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3, {
    wordBoundaryEnabled: true,
    sentenceBoundaryEnabled: true,
  });
  // msedge-tts sends the whole text as ONE request and does not split; it needs XML-escaped input.
  res.requests = 1;
  const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const { audioStream, metadataStream } = tts.toStream(escaped, { rate: RATE });
  const types = new Set();
  const audioDone = new Promise((resolve, reject) => {
    audioStream.on('data', (d) => { parts.push(d); res.bytes += d.length; });
    audioStream.on('error', reject);
    audioStream.on('close', resolve);
  });
  if (metadataStream) {
    metadataStream.on('data', (d) => {
      for (const m of JSON.parse(d.toString()).Metadata ?? []) {
        if (m.Type === 'WordBoundary' || m.Type === 'SentenceBoundary') {
          types.add(m.Type);
          res.boundary_events += 1;
          res.boundary_text_chars += [...(m.Data?.text?.Text ?? '')].length;
        }
      }
    });
  }
  await audioDone;
  res.boundary_type = [...types].join('+') || 'none';
  tts.close();
}

async function viaUniversal() {
  const { Communicate } = await import('edge-tts-universal');
  const c = new Communicate(text, { voice: VOICE, rate: RATE });
  // The library builds a generator of <=4096-byte pieces; one websocket request per piece.
  c.texts = [...c.texts];
  res.requests = c.texts.length;
  res.boundary_type = 'WordBoundary';
  for await (const ch of c.stream()) {
    if (ch.type === 'audio' && ch.data) {
      parts.push(ch.data);
      res.bytes += ch.data.length;
    } else if (ch.type === 'WordBoundary' || ch.type === 'SentenceBoundary') {
      res.boundary_events += 1;
      res.boundary_text_chars += [...(ch.text ?? '')].length;
    }
  }
}

try {
  if (lib === 'msedge-tts') await viaMsedge();
  else if (lib === 'edge-tts-universal') await viaUniversal();
  else throw new Error(`unknown lib ${lib}`);
} catch (e) {
  res.status = 'error';
  res.error = `${e?.name ?? 'Error'}: ${e?.message ?? e}`;
}
finish();
