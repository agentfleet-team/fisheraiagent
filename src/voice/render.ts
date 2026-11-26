import { createHash } from 'node:crypto';
import { AUDIO_FORMAT, type Mark, type VoiceRequest, type VoiceResult } from './contract.js';
import { chunkText } from './chunk.js';
import type { EngineResult, VoiceEngine } from './engine.js';
import { VoiceError } from './errors.js';

// The render, join and check nodes.

export const CHUNK_TIMEOUT_MS = 120_000;
const BYTES_PER_SECOND = 6000; // 48 kbit/s constant bitrate

export const audioMs = (audio: Buffer): number => Math.round((audio.length * 1000) / BYTES_PER_SECOND);

export interface RenderOptions {
  engine: VoiceEngine;
  chunkTimeoutMs?: number;
}

export interface Episode {
  audio: Buffer;
  result: VoiceResult;
}

// render-<section>-<chunk>: one request with a time limit, one retry. A second
// failure, an empty file or a chunk with no sentence boundary fails the job
// with the section id.
async function renderChunk(
  engine: VoiceEngine,
  request: VoiceRequest,
  sectionId: string,
  text: string,
  timeoutMs: number,
): Promise<EngineResult> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(new Error('chunk timeout')), timeoutMs);
      let out: EngineResult;
      try {
        // The race also ends an engine that ignores the signal.
        out = await Promise.race([
          engine({ text, voice: request.voice, signal: abort.signal }),
          new Promise<never>((_, reject) => abort.signal.addEventListener('abort', () => reject(abort.signal.reason), { once: true })),
        ]);
      } finally {
        clearTimeout(timer);
      }
      if (out.audio.length === 0 || out.sentences.length === 0) throw new Error('empty render');
      return out;
    } catch {
      // fall through to the retry
    }
  }
  throw new VoiceError('render_failed', sectionId);
}

// Sentence marks of one chunk, shifted by the chunk's start in the joined
// audio. Marks are ordered and never overlap; the last one ends inside the chunk.
function marksOf(
  sectionId: string,
  firstIndex: number,
  chunk: EngineResult,
  chunkStartMs: number,
): Mark[] {
  const chunkMs = audioMs(chunk.audio);
  const sorted = [...chunk.sentences].sort((a, b) => a.offset_ms - b.offset_ms);
  const marks: Mark[] = [];
  let cursor = 0;
  sorted.forEach((s, i) => {
    const start = Math.min(Math.max(s.offset_ms, cursor), chunkMs);
    const nextStart = i + 1 < sorted.length ? sorted[i + 1].offset_ms : chunkMs;
    const limit = Math.min(Math.max(nextStart, start), chunkMs);
    const end = Math.min(Math.max(s.offset_ms + s.duration_ms, start), limit);
    cursor = end;
    marks.push({
      section_id: sectionId,
      index: firstIndex + i,
      start_ms: chunkStartMs + start,
      end_ms: chunkStartMs + end,
      text: s.text,
    });
  });
  return marks;
}

export async function renderEpisode(request: VoiceRequest, options: RenderOptions): Promise<Episode> {
  const timeoutMs = options.chunkTimeoutMs ?? CHUNK_TIMEOUT_MS;
  const parts: Buffer[] = [];
  const marks: Mark[] = [];
  let joinedMs = 0;
  for (const section of request.sections) {
    let index = 0;
    for (const text of chunkText(section.text)) {
      const chunk = await renderChunk(options.engine, request, section.id, text, timeoutMs);
      const chunkMarks = marksOf(section.id, index, chunk, joinedMs);
      marks.push(...chunkMarks);
      index += chunkMarks.length;
      parts.push(chunk.audio);
      joinedMs += audioMs(chunk.audio);
    }
    if (index === 0) throw new VoiceError('render_failed', section.id);
  }
  // join node
  const audio = Buffer.concat(parts);
  const durationS = audioMs(audio) / 1000;
  // check node: a cut-off or runaway file never leaves the tool.
  if (durationS < request.expect_seconds.min || durationS > request.expect_seconds.max) {
    throw new VoiceError('duration_out_of_band');
  }
  return {
    audio,
    result: {
      duration_s: Math.round(durationS * 10) / 10,
      bytes: audio.length,
      sha256: createHash('sha256').update(audio).digest('hex'),
      format: AUDIO_FORMAT,
      marks,
    },
  };
}
