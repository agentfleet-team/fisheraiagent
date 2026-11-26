// `transcribe captions <url-or-id> [--accept manual|manual-or-auto]
// [--receipt <file>]` (agentfleet-team/fisheraiagent#89). It prints the
// Transcript built from the caption track alone: the #76 reader, rule and
// cuesToBlocks, unchanged. It never calls Gemini and reads no key.
//
// Exit codes: 0 a track was accepted (JSON on stdout), 3 no acceptable
// track (kind `none`, or `auto` under the default policy), 1 the read
// failed (one stderr line `captions_unavailable reason=<r>`), 2 usage.
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { loadServiceConfig } from './config.js';
import { captionsTranscript, type CaptionReader, type CaptionRead } from './captions.js';
import { parseYouTubeVideoId } from './youtube-url.js';
import type { TranscriptBlock } from './transcript.js';

export type AcceptPolicy = 'manual' | 'manual-or-auto';

export interface CaptionsIo {
  reader: CaptionReader;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  now?: () => Date;
}

interface Parsed {
  videoId: string;
  accept: AcceptPolicy;
  receipt?: string;
}

function parseArgs(args: string[]): Parsed | undefined {
  let input: string | undefined;
  let accept: AcceptPolicy = 'manual';
  let receipt: string | undefined;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === undefined) return undefined;
    if (arg === '--accept' || arg === '--receipt') {
      const value = args[i + 1];
      if (value === undefined) return undefined;
      i += 1;
      if (arg === '--receipt') receipt = value;
      else if (value === 'manual' || value === 'manual-or-auto') accept = value;
      else return undefined;
    } else if (arg.startsWith('--') || input !== undefined) {
      return undefined;
    } else {
      input = arg;
    }
  }
  if (input === undefined) return undefined;
  try {
    return { videoId: parseYouTubeVideoId(input), accept, receipt };
  } catch {
    return undefined;
  }
}

const blocksSha256 = (blocks: TranscriptBlock[]): string =>
  createHash('sha256').update(JSON.stringify(blocks)).digest('hex');

function describe(read: CaptionRead): { kind: string; reason: string | null; language: string | null; cueCount: number } {
  switch (read.kind) {
    case 'manual':
    case 'auto':
      return { kind: read.kind, reason: null, language: read.language, cueCount: read.cues.length };
    case 'none':
      return { kind: 'none', reason: null, language: null, cueCount: 0 };
    case 'unavailable':
      return { kind: 'unavailable', reason: read.reason, language: null, cueCount: 0 };
  }
}

export async function captionsMain(args: string[], io: CaptionsIo): Promise<number> {
  const parsed = parseArgs(args);
  if (parsed === undefined) {
    io.stderr('usage: transcribe captions <url-or-id> [--accept manual|manual-or-auto] [--receipt <file>]\n');
    return 2;
  }
  const { maxBlockSeconds } = loadServiceConfig();
  const started = Date.now();
  const read = await io.reader(parsed.videoId);
  const ms = Date.now() - started;

  const accepted =
    read.kind === 'manual' || (read.kind === 'auto' && parsed.accept === 'manual-or-auto') ? read : undefined;
  const transcript =
    accepted !== undefined && (accepted.kind === 'manual' || accepted.kind === 'auto')
      ? captionsTranscript(parsed.videoId, accepted, maxBlockSeconds)
      : undefined;

  if (parsed.receipt !== undefined) {
    const d = describe(read);
    writeFileSync(
      parsed.receipt,
      JSON.stringify(
        {
          video_id: parsed.videoId,
          kind: d.kind,
          reason: d.reason,
          language: d.language,
          cue_count: d.cueCount,
          blocks_sha256: transcript === undefined ? null : blocksSha256(transcript.blocks),
          ms,
          method: 'innertube-android',
          fetched_at: (io.now ?? (() => new Date()))().toISOString(),
        },
        null,
        2,
      ) + '\n',
    );
  }

  if (transcript !== undefined) {
    io.stdout(JSON.stringify(transcript, null, 2) + '\n');
    return 0;
  }
  if (read.kind === 'unavailable') {
    io.stderr(`captions_unavailable reason=${read.reason}\n`);
    return 1;
  }
  return 3;
}
