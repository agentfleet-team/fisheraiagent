export interface TranscriptBlock {
  start: number;
  end: number;
  text: string;
}

// How a transcript was made: from a manual caption track, from the
// speech-recognition track (a job whose tenant sets `captions` to
// "manual-or-auto"), or by Gemini.
export type TranscriptSource = 'captions:manual' | 'captions:auto' | 'gemini';

export interface Transcript {
  video_id: string;
  source_url: string;
  language: string;
  blocks: TranscriptBlock[];
  source: TranscriptSource;
}
