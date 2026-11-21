export interface TranscriptBlock {
  start: number;
  end: number;
  text: string;
}

export interface Transcript {
  video_id: string;
  source_url: string;
  language: string;
  blocks: TranscriptBlock[];
}
