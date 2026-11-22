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

export interface ParseOptions {
  // Allow a response with a header but no blocks: on a continuation the
  // model reports "no spoken audio left in this range" with LANGUAGE only.
  allowEmpty?: boolean;
}

// Block times are MM:SS (HH:MM:SS past one hour) per the video docs; plain
// seconds are still accepted so tolerant parsing survives model drift.
// A line that opens with a bracket ([, ［ or 【) and carries a time-like
// token (digits, ASCII or full-width colon, digits) is block intent: it
// must parse fully as a range block or the whole output is rejected,
// never absorbed as text. Bracket-led lines with no time-like token
// ([music], 【拍手】) stay text.
const BLOCK_INTENT = /^[\[［【]/;
const TIME_TOKEN = /\d+\s*[:：]\s*\d+/;
const BLOCK_SHAPE = /^\[([^\]\-]*)-([^\]]*)\]\s*(.*)$/;
const TIMESTAMP = /^\d+(?::\d{1,2}){0,2}(?:\.\d+)?$/;
const HEADER_LINE = /^\s*(LANGUAGE|DURATION)\s*:/im;
const DURATION_LINE = /^DURATION:\s*(\S+)\s*$/i;
const LANGUAGE_LINE = /^LANGUAGE:\s*(\S+)\s*$/i;
const EPS = 1e-3;

type Line =
  | { kind: 'skip' }
  | { kind: 'language'; value: string }
  | { kind: 'block'; block: TranscriptBlock }
  | { kind: 'duration'; value: number }
  | { kind: 'text'; text: string };

/** Seconds for a valid timestamp, or undefined when any component is out of range. */
function timestampToSeconds(raw: string): number | undefined {
  const value = raw.trim();
  if (!TIMESTAMP.test(value)) return undefined;
  const parts = value.split(':');
  let seconds = 0;
  for (const [index, part] of parts.entries()) {
    const number = Number.parseFloat(part);
    // Hours are unbounded; minutes and seconds in colon forms are 0-59.
    const isHours = parts.length === 3 && index === 0;
    if (parts.length > 1 && !isHours && number >= 60) return undefined;
    seconds = seconds * 60 + number;
  }
  return seconds;
}

function classifyLine(line: string, lineNumber: number): Line {
  const text = line.trim();
  if (!text || text.startsWith('```')) return { kind: 'skip' };
  // A DURATION line is consumed but never trusted as the video end; a
  // numeric value is still reported so a caller can enforce a length cap.
  const duration = DURATION_LINE.exec(text);
  if (duration) {
    const value = Number.parseFloat(duration[1]);
    return Number.isFinite(value) ? { kind: 'duration', value } : { kind: 'skip' };
  }
  const lang = LANGUAGE_LINE.exec(text);
  if (lang) return { kind: 'language', value: lang[1] };
  const shape = BLOCK_SHAPE.exec(text);
  if (shape) {
    const start = timestampToSeconds(shape[1]);
    const end = timestampToSeconds(shape[2]);
    if (start === undefined || end === undefined) {
      throw new ModelOutputError(`line ${lineNumber}: invalid timestamp in "${text.slice(0, 60)}"`);
    }
    return { kind: 'block', block: { start, end, text: shape[3].trim() } };
  }
  if (BLOCK_INTENT.test(text) && TIME_TOKEN.test(text)) {
    throw new ModelOutputError(`line ${lineNumber}: invalid timestamp in "${text.slice(0, 60)}"`);
  }
  return { kind: 'text', text };
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
  let durationSeconds: number | undefined;
  let language = 'unknown';
  const blocks: TranscriptBlock[] = [];

  for (const [index, line] of raw.split('\n').entries()) {
    const parsed = classifyLine(line, index + 1);
    switch (parsed.kind) {
      case 'skip':
        break;
      case 'language':
        language = parsed.value;
        break;
      case 'duration':
        durationSeconds = parsed.value;
        break;
      case 'block':
        blocks.push(parsed.block);
        break;
      case 'text': {
        // Continuation text for the previous block; text before the first
        // block is preamble and is ignored.
        const last = blocks[blocks.length - 1];
        if (last) last.text = last.text ? `${last.text} ${parsed.text}` : parsed.text;
        break;
      }
    }
  }

  if (blocks.length === 0) {
    if (options?.allowEmpty && HEADER_LINE.test(raw)) {
      return { durationSeconds, language, blocks };
    }
    throw new ModelOutputError('no transcript blocks in model output');
  }

  let previousStart = -EPS;
  for (const [index, b] of blocks.entries()) {
    if (b.end < b.start) {
      throw new ModelOutputError(`block ${index + 1}: end (${b.end}) is before start (${b.start})`);
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
