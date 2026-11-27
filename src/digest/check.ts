import {
  modelOutput,
  type EpisodeRequest,
  type EpisodeScript,
  type EpisodeSection,
  type ModelOutput,
} from './contract.js';
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

// The script check: schema, structure, refs and length band. It returns the
// EpisodeScript, or every problem it found so one repair call can name them.
export function checkModelOutput(request: EpisodeRequest, profile: Profile, raw: string): CheckResult {
  const output = parseModelJson(raw);
  if (output === undefined) {
    return { ok: false, problems: ['輸出不是符合格式的 JSON 物件（title 與 sections）。'] };
  }
  const problems: string[] = [];
  const { sections } = output;

  const opening = sections.filter((s) => s.kind === 'opening');
  const closing = sections.filter((s) => s.kind === 'closing');
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
  const charCount = countChars(spoken);
  const { min, max } = profile.lengthBand;
  if (charCount < min || charCount > max) {
    problems.push(`全部文字合計 ${charCount} 字，必須在 ${min} 到 ${max} 字之間。`);
  }

  if (problems.length > 0) return { ok: false, problems };

  const built: EpisodeSection[] = sections.map((s) => {
    if (s.kind === 'opening') return { id: 'opening', kind: 'opening', text: s.text };
    if (s.kind === 'closing') return { id: 'closing', kind: 'closing', text: s.text };
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
