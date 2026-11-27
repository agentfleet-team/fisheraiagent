import { modelOutput, type ModelOutput } from './contract.js';
import { countChars } from './check.js';

export interface FitResult {
  raw: string;
  removed: number;
  charsBefore: number;
  charsAfter: number;
}

// A sentence ends at 。！？ or at a line end; the terminator stays with it,
// and so do closing quotes and brackets that follow it (「…。」).
function pieces(text: string): string[] {
  return text.split(/(?<=[。！？][」』”’）)]*|\n)(?![」』”’）)])/u);
}
const spoken = (p: string): boolean => p.trim() !== '';

// The deterministic last step before the final check. When the model output
// is still above `max`, drop whole sentences from the end of the longest
// segment, repeating on the then-longest segment, until the total (with the
// tenant's fixed chars) is at most `max`. Opening and closing bodies are never
// touched, a segment keeps its last sentence and its refs, and a removal never
// takes the total below `min`. Returns undefined when the output does not
// parse, is not above `max`, or cannot be fitted under these rules; the caller
// then checks the original output unchanged.
export function fitModelOutput(raw: string, fixedChars: number, min: number, max: number): FitResult | undefined {
  const trimmed = raw.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(trimmed);
  let value: unknown;
  try {
    value = JSON.parse(fenced ? fenced[1] : trimmed);
  } catch {
    return undefined;
  }
  const parsed = modelOutput.safeParse(value);
  if (!parsed.success) return undefined;
  const output: ModelOutput = parsed.data;
  const total = (): number => countChars(output.sections.map((s) => s.text)) + fixedChars;
  const charsBefore = total();
  if (charsBefore <= max) return undefined;

  let removed = 0;
  while (total() > max) {
    const candidates = output.sections
      .filter((s) => s.kind === 'segment' && pieces(s.text).filter(spoken).length >= 2)
      .sort((a, b) => countChars([b.text]) - countChars([a.text]));
    let done = false;
    for (const seg of candidates) {
      const all = pieces(seg.text);
      while (all.length > 0 && !spoken(all[all.length - 1])) all.pop();
      const last = all.pop() ?? '';
      if (total() - countChars([last]) < min) continue;
      seg.text = all.join('');
      removed += 1;
      done = true;
      break;
    }
    if (!done) return undefined;
  }
  return { raw: JSON.stringify(output), removed, charsBefore, charsAfter: total() };
}
