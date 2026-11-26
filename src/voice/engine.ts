import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts';
import { z } from 'zod';
import type { VoiceSettings } from './contract.js';

export interface EngineSentence {
  text: string;
  // Start and length inside this chunk's audio.
  offset_ms: number;
  duration_ms: number;
}

export interface EngineResult {
  audio: Buffer;
  sentences: EngineSentence[];
}

export interface EngineRequest {
  text: string;
  voice: VoiceSettings;
  // Aborts when the chunk's time limit passes. The engine must stop and reject.
  signal: AbortSignal;
}

// One TTS request: complete audio for the text plus one entry per sentence
// boundary. A library error rejects; a partial file is never returned.
export type VoiceEngine = (request: EngineRequest) => Promise<EngineResult>;

const TICKS_PER_MS = 10_000;

const boundaryMessage = z.object({
  Metadata: z
    .array(
      z.object({
        Type: z.string().optional(),
        Data: z
          .object({
            Offset: z.number().optional(),
            Duration: z.number().optional(),
            text: z.object({ Text: z.string().optional() }).optional(),
          })
          .optional(),
      }),
    )
    .default([]),
});

function sentencesFrom(raw: string[]): EngineSentence[] {
  const out: EngineSentence[] = [];
  for (const message of raw) {
    let json: unknown;
    try {
      json = JSON.parse(message);
    } catch {
      continue;
    }
    const parsed = boundaryMessage.safeParse(json);
    if (!parsed.success) continue;
    for (const event of parsed.data.Metadata) {
      if (event.Type !== 'SentenceBoundary') continue;
      const offset = event.Data?.Offset;
      const duration = event.Data?.Duration;
      const text = event.Data?.text?.Text;
      if (offset === undefined || duration === undefined || text === undefined) continue;
      out.push({ text, offset_ms: Math.round(offset / TICKS_PER_MS), duration_ms: Math.round(duration / TICKS_PER_MS) });
    }
  }
  return out;
}

const escapeXml = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// msedge-tts 2.1.1 (spike #74): sends the whole text as one request, so the
// caller chunks first. It rejects when the socket closes before turn.end.
export const edgeEngine: VoiceEngine = async ({ text, voice, signal }) => {
  const tts = new MsEdgeTTS({ synthesisTimeoutMs: 0 });
  const onAbort = (): void => tts.close();
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    signal.throwIfAborted();
    await tts.setMetadata(voice.name, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3, {
      sentenceBoundaryEnabled: true,
      wordBoundaryEnabled: false,
    });
    const { audioStream, metadataStream } = tts.toStream(escapeXml(text), { rate: voice.rate });
    const parts: Buffer[] = [];
    const metadata: string[] = [];
    metadataStream?.on('data', (d: Buffer) => metadata.push(d.toString()));
    await new Promise<void>((resolve, reject) => {
      audioStream.on('data', (d: Buffer) => parts.push(d));
      audioStream.on('error', reject);
      audioStream.on('close', resolve);
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
    signal.throwIfAborted();
    return { audio: Buffer.concat(parts), sentences: sentencesFrom(metadata) };
  } finally {
    signal.removeEventListener('abort', onAbort);
    tts.close();
  }
};
