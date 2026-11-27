import type { EpisodeRequest } from './contract.js';
import type { FixedLines } from './check.js';

// A profile fixes the language, the structure, the length band and the
// source list of one kind of episode. Its constants live here, as data.
export interface Profile {
  id: string;
  // Allowed char_count of the spoken text: sections only, whitespace not counted.
  lengthBand: { min: number; max: number };
  system: string;
}

// The band comes from the tool-3 TTS spike (PR #82, spike/tts/REPORT.md): at
// -12% speech rate 262 characters make one audio minute in 12 of 12 runs. The
// episode acceptance is 9 to 11 minutes: 9 x 262 = 2,358 and 11 x 262 = 2,882
// characters. The band 2,400 to 2,850 sits inside that range with a small margin.
export const PODCAST_ZH_TW_10MIN_BAND = { min: 2400, max: 2850 };

const PODCAST_SYSTEM = [
  '你是一位台灣的 podcast 腳本作者。你把幾支 YouTube 影片的逐字稿，整理成一集約十分鐘的口語節目腳本。',
  '語言：台灣繁體中文，口語、清楚。英文技術名詞、產品名與人名保留原文，不翻譯。',
  '結構：一段 opening，接著每個來源一段 segment（依 slot 由小到大），最後一段 closing。',
  '只使用逐字稿裡有的內容，不補充逐字稿沒有說的事實。',
  '每個 segment 都要有 refs：至少一筆，指向逐字稿裡支持該段內容的時間點（video_id 與 start 秒數，start 取自逐字稿方括號內的數字）。',
  '如果有 missing_slots，在 opening 用恰好一句話交代，並寫出「第N則」（N 是缺少的 slot 編號），例如「今天第3則影片沒有取得，這集先略過。」不要為缺少的 slot 寫 segment。',
  'closing 只用口語收尾；來源清單（標題、頻道、連結）由系統另外附上，不要寫在 closing 裡。',
  '只輸出一個 JSON 物件，不要 Markdown 圍欄，格式：',
  '{"title": string, "sections": [{"kind": "opening", "text": string}, {"kind": "segment", "slot": number, "text": string, "refs": [{"video_id": string, "start": number}]}, {"kind": "closing", "text": string}]}',
].join('\n');

export const PROFILES: Readonly<Record<string, Profile>> = Object.freeze({
  'podcast-zh-tw-10min': {
    id: 'podcast-zh-tw-10min',
    lengthBand: PODCAST_ZH_TW_10MIN_BAND,
    system: PODCAST_SYSTEM,
  },
});

export function profileFor(id: string): Profile | undefined {
  return Object.hasOwn(PROFILES, id) ? PROFILES[id] : undefined;
}

function fmt(seconds: number): string {
  return String(Math.round(seconds * 10) / 10);
}

// The user prompt: the request, then each transcript as `[start] text` lines.
// A tenant's fixed lines spend part of the band, so the model's own target
// shrinks by their length and it is told not to write the framing the system
// adds: no greeting in the opening, no sign-off in the closing.
export function buildDraftPrompt(profile: Profile, request: EpisodeRequest, lines?: FixedLines): string {
  const { min, max } = profile.lengthBand;
  const own = lines === undefined ? '' : `，其中固定台詞 ${lines.chars} 字由系統加入；你的文字合計目標是 ${min - lines.chars} 到 ${max - lines.chars} 字`;
  const out: string[] = [
    `日期：${request.date}`,
    `長度：全部 section 的文字合計 ${min} 到 ${max} 字（不含空白）${own}。`,
    `missing_slots：${JSON.stringify(request.missing_slots)}`,
  ];
  if (lines !== undefined) {
    const fixed: string[] = [];
    if (lines.opening !== undefined) {
      fixed.push('opening 的固定開場台詞由系統加入，opening 直接從內容開始，不要寫問候語');
    }
    if (lines.closing !== undefined) {
      fixed.push('closing 的固定收尾台詞由系統加入，closing 不要寫收尾署名或道別語');
    }
    out.push(`固定台詞：${fixed.join('；')}。`);
  }
  out.push('');
  for (const s of request.sources) {
    out.push(
      `## 來源 slot ${s.slot}`,
      `video_id: ${s.transcript.video_id}`,
      `標題：${s.title}`,
      `頻道：${s.channel}`,
      `逐字稿語言：${s.transcript.language}`,
      '逐字稿：',
      ...s.transcript.blocks.map((b) => `[${fmt(b.start)}] ${b.text}`),
      '',
    );
  }
  return out.join('\n');
}

export function buildRepairPrompt(
  profile: Profile,
  request: EpisodeRequest,
  previous: string,
  problems: string[],
  lines?: FixedLines,
): string {
  return [
    buildDraftPrompt(profile, request, lines),
    '上一次的輸出沒有通過檢查。請修正下列問題，並重新輸出完整的 JSON 物件：',
    ...problems.map((p) => `- ${p}`),
    '',
    '上一次的輸出：',
    previous,
  ].join('\n');
}
