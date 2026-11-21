function formatSeconds(seconds: number): string {
  return Number(seconds.toFixed(3)).toString();
}

function formatRules(maxBlockSeconds: number): string {
  return [
    'Output format (strict):',
    'Line 1: DURATION: <total video length in seconds>',
    'Line 2: LANGUAGE: <BCP-47 language code of the spoken language>',
    'Then one line per transcript block:',
    '[<start seconds> - <end seconds>] <spoken text>',
    'Rules:',
    `- Each block spans at most ${formatSeconds(maxBlockSeconds)} seconds.`,
    '- Blocks are in time order.',
    '- Keep the spoken language as-is. Do not translate.',
    '- Output only the lines above. No preamble, no apology, no explanation, no code fences.',
  ].join('\n');
}

export function initialPrompt(maxBlockSeconds: number): string {
  return [
    'Transcribe the spoken audio of this video.',
    'Start at the first timestamp of the video and cover the entire video.',
    formatRules(maxBlockSeconds),
  ].join('\n');
}

export function rangePrompt(maxBlockSeconds: number, fromSeconds: number): string {
  return [
    `Transcribe the spoken audio of this video from ${formatSeconds(fromSeconds)} seconds to the end of the video.`,
    `Blocks start at ${formatSeconds(fromSeconds)} seconds.`,
    formatRules(maxBlockSeconds),
  ].join('\n');
}

export const STRICT_RETRY_SUFFIX =
  '\n\nOutput ONLY the format above. Do not explain. Do not apologize. Do not describe the video. Begin immediately with the DURATION line.';
