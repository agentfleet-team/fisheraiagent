// The chunk step of the render node: one section becomes pieces of at most
// MAX_CHUNK_CHARS characters, cut at sentence ends. Each piece is one TTS
// request and one retry unit (spike agentfleet-team/fisheraiagent#74).

export const MAX_CHUNK_CHARS = 1300;

const SENTENCE_END = /[。！？!?；;…]+["”」』)）]*|\n+/gu;
const SOFT_BREAK = /[，、,：:]/u;

function sentencesOf(text: string): string[] {
  const out: string[] = [];
  let last = 0;
  for (const m of text.matchAll(SENTENCE_END)) {
    const end = (m.index ?? 0) + m[0].length;
    out.push(text.slice(last, end));
    last = end;
  }
  if (last < text.length) out.push(text.slice(last));
  return out.filter((s) => s.trim() !== '');
}

// A sentence longer than the limit is cut at its last soft break (comma),
// else at the limit.
function splitLong(sentence: string, limit: number): string[] {
  const chars = [...sentence];
  const out: string[] = [];
  let start = 0;
  while (chars.length - start > limit) {
    const window = chars.slice(start, start + limit);
    let cut = limit;
    for (let i = window.length - 1; i > 0; i--) {
      if (SOFT_BREAK.test(window[i])) {
        cut = i + 1;
        break;
      }
    }
    out.push(chars.slice(start, start + cut).join(''));
    start += cut;
  }
  out.push(chars.slice(start).join(''));
  return out;
}

export function chunkText(text: string, limit: number = MAX_CHUNK_CHARS): string[] {
  const chunks: string[] = [];
  let current = '';
  let currentLen = 0;
  const flush = (): void => {
    if (current.trim() !== '') chunks.push(current.trim());
    current = '';
    currentLen = 0;
  };
  for (const sentence of sentencesOf(text)) {
    const len = [...sentence].length;
    const parts = len > limit ? splitLong(sentence, limit) : [sentence];
    for (const part of parts) {
      const partLen = [...part].length;
      if (currentLen + partLen > limit) flush();
      current += part;
      currentLen += partLen;
    }
  }
  flush();
  return chunks;
}
