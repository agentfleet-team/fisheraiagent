import type { TranscriptBlock } from './transcript.js';

export class ModelOutputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModelOutputError';
  }
}

export interface ParsedModelOutput {
  language: string;
  blocks: TranscriptBlock[];
}

export interface ParseOptions {
  // Allow a response with a header but no blocks: on a continuation the
  // model reports "no spoken audio left in this range" with LANGUAGE only.
  allowEmpty?: boolean;
}

// Block times are MM:SS (HH:MM:SS past one hour) per the video docs; plain
// seconds are still accepted so tolerant parsing survives model drift.
const TIMESTAMP = '\\d+(?::\\d{1,2}){0,2}(?:\\.\\d+)?';
const BLOCK_LINE = new RegExp(`^\\[\\s*(${TIMESTAMP})\\s*-\\s*(${TIMESTAMP})\\s*\\]\\s*(.*)$`);
const HEADER_LINE = /^\s*(LANGUAGE|DURATION)\s*:/im;
const DURATION_LINE = /^DURATION:\s*\S+\s*$/i;
const LANGUAGE_LINE = /^LANGUAGE:\s*(\S+)\s*$/i;
const EPS = 1e-3;

function timestampToSeconds(raw: string): number {
  let seconds = 0;
  for (const part of raw.split(':')) {
    const value = Number.parseFloat(part);
    if (!Number.isFinite(value)) return Number.NaN;
    seconds = seconds * 60 + value;
  }
  return seconds;
}

/**
 * Parse the model's transcript output. Tolerant of preamble lines and code
 * fences, strict about block shape, ordering and the block length limit.
 * Throws ModelOutputError when the output is not in the expected format.
 */
export function parseModelOutput(
  raw: string,
  maxBlockSeconds: number,
  options?: ParseOptions,
): ParsedModelOutput {
  let language = 'unknown';
  const blocks: TranscriptBlock[] = [];

  for (const line of raw.split('\n')) {
    const text = line.trim();
    if (!text || text.startsWith('```')) continue;

    // A DURATION line is consumed but never trusted as the video end.
    if (DURATION_LINE.test(text)) continue;
    const lang = LANGUAGE_LINE.exec(text);
    if (lang) {
      language = lang[1];
      continue;
    }
    const block = BLOCK_LINE.exec(text);
    if (block) {
      blocks.push({
        start: timestampToSeconds(block[1]),
        end: timestampToSeconds(block[2]),
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
    if (options?.allowEmpty && HEADER_LINE.test(raw)) {
      return { language, blocks };
    }
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

  return { language, blocks };
}
