import type { TranscriptBlock } from './transcript.js';

export class ModelOutputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModelOutputError';
  }
}

export interface ParsedModelOutput {
  durationSeconds?: number;
  language: string;
  blocks: TranscriptBlock[];
}

const BLOCK_LINE = /^\[\s*(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)\s*\]\s*(.*)$/;
const DURATION_LINE = /^DURATION:\s*(\d+(?:\.\d+)?)\s*$/i;
const LANGUAGE_LINE = /^LANGUAGE:\s*(\S+)\s*$/i;
const EPS = 1e-3;

/**
 * Parse the model's transcript output. Tolerant of preamble lines and code
 * fences, strict about block shape, ordering and the block length limit.
 * Throws ModelOutputError when the output is not in the expected format.
 */
export function parseModelOutput(raw: string, maxBlockSeconds: number): ParsedModelOutput {
  let durationSeconds: number | undefined;
  let language = 'unknown';
  const blocks: TranscriptBlock[] = [];

  for (const line of raw.split('\n')) {
    const text = line.trim();
    if (!text || text.startsWith('```')) continue;

    const duration = DURATION_LINE.exec(text);
    if (duration) {
      durationSeconds = Number.parseFloat(duration[1]);
      continue;
    }
    const lang = LANGUAGE_LINE.exec(text);
    if (lang) {
      language = lang[1];
      continue;
    }
    const block = BLOCK_LINE.exec(text);
    if (block) {
      blocks.push({
        start: Number.parseFloat(block[1]),
        end: Number.parseFloat(block[2]),
        text: block[3].trim(),
      });
      continue;
    }
    // Continuation text for the previous block; ignore anything before the
    // first block (preamble).
    if (blocks.length > 0) {
      const last = blocks[blocks.length - 1];
      last.text = last.text ? `${last.text} ${text}` : text;
    }
  }

  if (blocks.length === 0) {
    throw new ModelOutputError('no transcript blocks in model output');
  }

  let previousStart = -EPS;
  for (const [index, b] of blocks.entries()) {
    if (!Number.isFinite(b.start) || !Number.isFinite(b.end)) {
      throw new ModelOutputError(`block ${index + 1}: non-numeric timestamp`);
    }
    if (b.end <= b.start) {
      throw new ModelOutputError(`block ${index + 1}: end (${b.end}) is not after start (${b.start})`);
    }
    if (b.end - b.start > maxBlockSeconds + EPS) {
      throw new ModelOutputError(
        `block ${index + 1}: ${(b.end - b.start).toFixed(3)}s exceeds ${maxBlockSeconds}s limit`,
      );
    }
    if (b.start < previousStart - EPS) {
      throw new ModelOutputError(`block ${index + 1}: start (${b.start}) is before the previous block start`);
    }
    previousStart = b.start;
  }

  return { durationSeconds, language, blocks };
}
