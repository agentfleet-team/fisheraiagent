export interface TranscriptBlock {
  start: number;
  end: number;
  text: string;
}

// How a transcript was made: from a manual caption track, from an auto
// track, or by Gemini. T1 produces `captions:manual` and `gemini`;
// `captions:auto` arrives with the tenant captions setting (T2).
export type TranscriptSource = 'captions:manual' | 'captions:auto' | 'gemini';

export interface Transcript {
  video_id: string;
  source_url: string;
  language: string;
  blocks: TranscriptBlock[];
  source: TranscriptSource;
}
