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
    'Line 2 (when known): DURATION: <length of the full source video in seconds>',
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

// One prompt shape for every call: the request always carries a clipped
// interval, so the model's block times are relative to the clip start — a
// known offset the caller adds back, not something the model must track.
// The length is stated as an upper bound: when the video ends inside the
// clip an exact "is N seconds" claim makes the model stretch block times to
// fill it. Only a re-asked tail window (exactLength) states a real length —
// its clip end was estimated from the per-call token count, so the claim
// there is true.
export function clipPrompt(maxBlockSeconds: number, clipSeconds: number, exactLength = false): string {
  const end = formatTimestamp(clipSeconds);
  const length = exactLength
    ? `The clip is ${formatSeconds(clipSeconds)} seconds long; its last frame is ${end}.`
    : `The clip is at most ${formatSeconds(clipSeconds)} seconds long; it is shorter when the video ends sooner, so its last frame can be earlier than ${end}. Never stretch block times to fill the clip.`;
  return [
    'Transcribe the spoken audio of this clip.',
    length,
    'Report every block time relative to the clip: the first frame is 00:00, not the position the clip was cut from.',
    'If the clip has no spoken audio, output only the LANGUAGE line.',
    formatRules(maxBlockSeconds),
  ].join('\n');
}

export const STRICT_RETRY_SUFFIX =
  '\n\nOutput ONLY the format above. Do not explain. Do not apologize. Do not describe the video. Begin immediately with the LANGUAGE line.';
