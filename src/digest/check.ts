import {
  modelOutput,
  type EpisodeRequest,
  type EpisodeScript,
  type EpisodeSection,
  type ModelOutput,
} from './contract.js';
import type { TenantDigest } from '../tenants.js';
import type { Profile } from './profile.js';

export type CheckResult =
  | { ok: true; script: EpisodeScript }
  | { ok: false; problems: string[] };

// Characters that count toward the length band: the spoken text of every
// section, whitespace excluded.
export function countChars(texts: string[]): number {
  let n = 0;
  for (const t of texts) for (const ch of t) if (!/\s/u.test(ch)) n += 1;
  return n;
}

// A tenant's fixed framing lines, resolved for one job. `chars` is the part
// of the length band the lines already spend.
export interface FixedLines {
  opening?: string;
  closing?: string;
  chars: number;
}

// undefined when the tenant sets no line, so a tenant without them gets
// exactly the behavior a caller without a tenant gets.
export function fixedLines(digest: TenantDigest | undefined): FixedLines | undefined {
  if (digest?.opening_line === undefined && digest?.closing_line === undefined) return undefined;
  const lines: FixedLines = {
    chars: countChars([digest.opening_line, digest.closing_line].filter((v): v is string => v !== undefined)),
  };
  if (digest.opening_line !== undefined) lines.opening = digest.opening_line;
  if (digest.closing_line !== undefined) lines.closing = digest.closing_line;
  return lines;
}

function sentences(text: string): string[] {
  return text.split(/(?<=[。！？!?\n])/u).filter((x) => x.trim() !== '');
}
function firstSentence(text: string): string {
  return sentences(text)[0] ?? '';
}
function lastSentence(text: string): string {
  const all = sentences(text);
  return all[all.length - 1] ?? '';
}

function parseModelJson(raw: string): ModelOutput | undefined {
  const trimmed = raw.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(trimmed);
  let value: unknown;
  try {
    value = JSON.parse(fenced ? fenced[1] : trimmed);
  } catch {
    return undefined;
  }
  const parsed = modelOutput.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function mentionsSlot(text: string, slot: number): boolean {
  return new RegExp(`第\\s*${slot}\\s*則`).test(text);
}

// The length problem names the total, the exact miss against the bound the
// draft crossed, and a per-section cut or add scaled from the actual section
// lengths toward the band midpoint, so a repair call targets the band center
// instead of hovering at an edge. Fixed framing lines are not model text, so
// they are excluded from the adjustable total and never get a suggestion.
function lengthProblem(
  sections: { kind: string; slot?: number; text: string }[],
  charCount: number,
  min: number,
  max: number,
  fixedChars: number,
): string {
  const mid = Math.round((min + max) / 2);
  const adjustable = charCount - fixedChars;
  const budget = mid - fixedChars;
  // A draft with no countable text has no lengths to scale, so the budget is
  // split evenly; the last section takes the rounding remainder.
  const even = Math.floor(budget / sections.length);
  const scale = adjustable > 0 ? budget / adjustable : 0;
  const parts = sections.map((s, i) => {
    const name = s.kind === 'segment' ? `slot ${s.slot ?? '?'}` : s.kind;
    const len = countChars([s.text]);
    const target =
      adjustable > 0
        ? Math.round(len * scale)
        : i === sections.length - 1
          ? budget - even * (sections.length - 1)
          : even;
    return `${name} 目前 ${len} 字 → 約 ${target} 字`;
  });
  const over = charCount > max;
  const miss = over ? `超出上限 ${charCount - max} 字` : `不足下限 ${min - charCount} 字`;
  const verb = over ? '縮減' : '擴寫';
  return `全部文字合計 ${charCount} 字，必須在 ${min} 到 ${max} 字之間。${miss}，請${verb}到合計約 ${mid} 字：${parts.join('，')}。`;
}

// The script check: schema, structure, refs and length band. It returns the
// EpisodeScript, or every problem it found so one repair call can name them.
// When a tenant fixes an opening_line or closing_line the line is structure,
// not model text: the check runs on the model's bodies, and the system
// composes the section after the body passes — opening_line before the
// opening body, closing_line after the closing body, both verbatim. A body
// that echoes the configured line, opens with a greeting or ends with a
// sign-off (the profile's lists) is a check problem, so the composed result
// holds each fixed line exactly once. The lines count toward the band.
export function checkModelOutput(
  request: EpisodeRequest,
  profile: Profile,
  raw: string,
  lines?: FixedLines,
): CheckResult {
  const output = parseModelJson(raw);
  if (output === undefined) {
    return { ok: false, problems: ['輸出不是符合格式的 JSON 物件（title 與 sections）。'] };
  }
  const problems: string[] = [];
  const { sections } = output;

  const opening = sections.filter((s) => s.kind === 'opening');
  const closing = sections.filter((s) => s.kind === 'closing');
  const firstOpening = opening[0];
  const lastClosing = closing[closing.length - 1];
  // Both framing bodies are checked for both configured lines: an echo in
  // either body would put a second copy of the line into the composed script.
  const bodies = [firstOpening, lastClosing].filter((s) => s !== undefined);
  const echoes = (line: string | undefined): boolean =>
    line !== undefined && bodies.some((s) => s.text.includes(line));
  if (echoes(lines?.opening)) {
    problems.push('固定開場台詞由系統加入，opening 與 closing 都不要重複寫出固定台詞（開場台詞），請直接從內容開始。');
  }
  if (echoes(lines?.closing)) {
    problems.push('固定收尾台詞由系統加入，opening 與 closing 都不要重複寫出固定台詞（收尾台詞）。');
  }
  if (
    lines?.opening !== undefined &&
    firstOpening !== undefined &&
    profile.greetings.some((g) => g.test(firstSentence(firstOpening.text)))
  ) {
    problems.push('固定開場台詞由系統加入，opening 不可再寫問候語，請直接從內容開始。');
  }
  if (
    lines?.closing !== undefined &&
    lastClosing !== undefined &&
    profile.signoffs.some((s) => s.test(lastSentence(lastClosing.text)))
  ) {
    problems.push('固定收尾台詞由系統加入，closing 不可再寫收尾署名或道別語。');
  }
  if (opening.length !== 1 || sections[0]?.kind !== 'opening') {
    problems.push('sections 必須以恰好一段 opening 開頭。');
  }
  if (closing.length !== 1 || sections[sections.length - 1]?.kind !== 'closing') {
    problems.push('sections 必須以恰好一段 closing 結尾。');
  }

  const segments = sections.filter((s) => s.kind === 'segment');
  const expectedSlots = request.sources.map((s) => s.slot);
  const gotSlots = segments.map((s) => s.slot);
  if (JSON.stringify(gotSlots) !== JSON.stringify(expectedSlots)) {
    problems.push(`segment 的 slot 必須依序為 ${JSON.stringify(expectedSlots)}，目前是 ${JSON.stringify(gotSlots)}。`);
  }

  for (const seg of segments) {
    const source = request.sources.find((s) => s.slot === seg.slot);
    if (source === undefined) continue;
    const refs = seg.refs ?? [];
    if (refs.length === 0) {
      problems.push(`slot ${seg.slot} 的 segment 沒有 refs。`);
      continue;
    }
    for (const ref of refs) {
      // Fixed wording only: the model's video_id string never enters a problem,
      // because problems reach the service log and the HTTP job error.
      if (ref.video_id !== source.transcript.video_id) {
        problems.push(`slot ${seg.slot} 的 ref（時間 ${ref.start}）不在該來源的逐字稿時間內，因為 video_id 與該來源不符。`);
      } else if (!source.transcript.blocks.some((b) => ref.start >= b.start && ref.start <= b.end)) {
        problems.push(`slot ${seg.slot} 的 ref（時間 ${ref.start}）不在該來源的逐字稿時間內。`);
      }
    }
  }

  const framing = [...opening, ...closing].map((s) => s.text).join('\n');
  for (const slot of request.missing_slots) {
    if (!mentionsSlot(framing, slot)) {
      problems.push(`opening 必須用一句話交代缺少的來源，並寫出「第${slot}則」。`);
    }
  }

  const spoken = sections.map((s) => s.text);
  const charCount = countChars(spoken) + (lines?.chars ?? 0);
  const { min, max } = profile.lengthBand;
  if (charCount < min || charCount > max) {
    problems.push(lengthProblem(sections, charCount, min, max, lines?.chars ?? 0));
  }

  if (problems.length > 0) return { ok: false, problems };

  const built: EpisodeSection[] = sections.map((s) => {
    if (s.kind === 'opening') {
      const text = lines?.opening === undefined ? s.text : `${lines.opening}\n${s.text}`;
      return { id: 'opening', kind: 'opening', text };
    }
    if (s.kind === 'closing') {
      const text = lines?.closing === undefined ? s.text : `${s.text}\n${lines.closing}`;
      return { id: 'closing', kind: 'closing', text };
    }
    const source = request.sources.find((src) => src.slot === s.slot);
    return {
      id: `s${s.slot}`,
      kind: 'segment',
      slot: s.slot ?? 0,
      video_id: source?.transcript.video_id ?? '',
      text: s.text,
      refs: s.refs ?? [],
    };
  });

  return {
    ok: true,
    script: {
      profile: profile.id,
      title: output.title,
      sections: built,
      char_count: charCount,
      markdown: renderMarkdown(request, output.title, built),
    },
  };
}

// The Markdown file the save node writes. The source list (title, channel,
// link per source) is appended here, after the closing, by the tool itself:
// the model writes only the spoken text.
export function renderMarkdown(request: EpisodeRequest, title: string, sections: EpisodeSection[]): string {
  const out: string[] = [`# ${title}`, `日期：${request.date}`, ''];
  for (const s of sections) {
    if (s.kind === 'opening') out.push('## 開場', '', s.text, '');
    else if (s.kind === 'closing') out.push('## 結尾', '', s.text, '');
    else {
      const source = request.sources.find((src) => src.slot === s.slot);
      out.push(`## 第 ${s.slot} 則：${source?.title ?? ''}`, '', s.text, '');
      out.push(`參考時間：${s.refs.map((r) => `${r.start}s`).join('、')}`, '');
    }
  }
  out.push('## 來源', '');
  for (const src of request.sources) out.push(`- ${src.title}｜${src.channel}｜${src.url}`);
  out.push('');
  return out.join('\n');
}
