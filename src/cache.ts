import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Transcript } from './transcript.js';

// Bumped whenever the prompt, the transcript output shape or the model
// output parser changes. It is part of the cache key, so entries written
// by an older format are misses: no migration, no deletion.
export const TRANSCRIPT_FORMAT_VERSION = 1;

function cacheFileName(videoId: string, model: string, maxBlockSeconds: number, formatVersion: number): string {
  const hash = createHash('sha256')
    .update(`${videoId}\n${model}\n${maxBlockSeconds}\n${formatVersion}`)
    .digest('hex')
    .slice(0, 16);
  return `${videoId}-${hash}.json`;
}

export async function readCachedTranscript(
  cacheDir: string,
  videoId: string,
  model: string,
  maxBlockSeconds: number,
  formatVersion: number,
): Promise<Transcript | null> {
  try {
    const raw = await readFile(
      join(cacheDir, cacheFileName(videoId, model, maxBlockSeconds, formatVersion)),
      'utf8',
    );
    const parsed: Transcript = JSON.parse(raw);
    if (parsed.video_id !== videoId || !Array.isArray(parsed.blocks)) return null;
    return parsed;
  } catch {
    return null;
  }
}

// The end of the last cached block: a lower bound on the video's length
// known without any Gemini call, used by the per-tenant length limit to
// reject an over-length video before a job touches the model.
export async function cachedVideoCoverage(
  cacheDir: string,
  videoId: string,
  model: string,
  maxBlockSeconds: number,
  formatVersion: number,
): Promise<number | undefined> {
  const cached = await readCachedTranscript(cacheDir, videoId, model, maxBlockSeconds, formatVersion);
  if (!cached || cached.blocks.length === 0) return undefined;
  return Math.max(...cached.blocks.map((b) => b.end));
}

export async function writeCachedTranscript(
  cacheDir: string,
  transcript: Transcript,
  model: string,
  maxBlockSeconds: number,
  formatVersion: number,
): Promise<void> {
  await mkdir(cacheDir, { recursive: true });
  const target = join(cacheDir, cacheFileName(transcript.video_id, model, maxBlockSeconds, formatVersion));
  const tmp = `${target}.tmp-${process.pid}-${randomUUID()}`;
  await writeFile(tmp, JSON.stringify(transcript, null, 2) + '\n', 'utf8');
  await rename(tmp, target);
}
