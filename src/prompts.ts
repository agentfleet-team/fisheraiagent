function formatSeconds(seconds: number): string {
  return Number(seconds.toFixed(3)).toString();
}

// Timestamp format from the Gemini video-understanding docs: MM:SS, or
// HH:MM:SS once the video runs past one hour.
export function formatTimestamp(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

function formatRules(maxBlockSeconds: number): string {
  return [
    'Output format (strict):',
    'Line 1: LANGUAGE: <BCP-47 language code of the spoken language>',
    'Then one line per transcript block:',
    '[MM:SS - MM:SS] <spoken text>',
    'Rules:',
    '- Block times use MM:SS; use HH:MM:SS past one hour.',
    `- Each block spans at most ${formatSeconds(maxBlockSeconds)} seconds.`,
    '- Blocks are in time order and cover the audio continuously. Do not skip any spoken part.',
    '- Keep the spoken language as-is. Do not translate.',
    '- Output only the lines above. No preamble, no apology, no explanation, no code fences.',
  ].join('\n');
}

export function initialPrompt(maxBlockSeconds: number): string {
  return [
    'Transcribe the spoken audio of this video.',
    'Start at the first timestamp of the video and cover it to the end. Do not stop early.',
    formatRules(maxBlockSeconds),
  ].join('\n');
}

export function rangePrompt(maxBlockSeconds: number, fromSeconds: number): string {
  const from = formatTimestamp(fromSeconds);
  return [
    `Transcribe the spoken audio of this video from ${from} to the end of the video.`,
    `Blocks start at ${from}.`,
    `If there is no spoken audio from ${from} onward, output only the LANGUAGE line.`,
    formatRules(maxBlockSeconds),
  ].join('\n');
}

export const STRICT_RETRY_SUFFIX =
  '\n\nOutput ONLY the format above. Do not explain. Do not apologize. Do not describe the video. Begin immediately with the LANGUAGE line.';
