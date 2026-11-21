import type { Transcript } from '../transcript.js';

function pad(n: number, width = 2): string {
  return String(n).padStart(width, '0');
}

// 3661.5 -> "1:01:01", 62 -> "1:02"
export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

function srtTimestamp(seconds: number): string {
  const total = Math.max(0, seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = Math.floor(total % 60);
  const ms = Math.round((total - Math.floor(total)) * 1000);
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(ms, 3)}`;
}

export function transcriptToTxt(transcript: Transcript): string {
  const lines = transcript.blocks.map(
    (b) => `[${formatDuration(b.start)}] ${b.text}`,
  );
  return `Transcript: ${transcript.source_url}\nLanguage: ${transcript.language}\n\n${lines.join('\n')}\n`;
}

export function transcriptToSrt(transcript: Transcript): string {
  return transcript.blocks
    .map(
      (b, i) =>
        `${i + 1}\n${srtTimestamp(b.start)} --> ${srtTimestamp(b.end)}\n${b.text}`,
    )
    .join('\n\n')
    .concat('\n');
}

function transcriptLengthSeconds(transcript: Transcript): number {
  return transcript.blocks.reduce((max, b) => Math.max(max, b.end), 0);
}

// The API returns no video title; the video id linked to its watch page is
// the closest honest label, plus the covered length.
export function summaryLine(transcript: Transcript): string {
  return `Transcript: [${transcript.video_id}](${transcript.source_url}) · ${transcript.language} · ${formatDuration(transcriptLengthSeconds(transcript))}`;
}
