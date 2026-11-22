import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Transcript } from './transcript.js';

function cacheFileName(videoId: string, model: string, maxBlockSeconds: number): string {
  const hash = createHash('sha256')
    .update(`${videoId}\n${model}\n${maxBlockSeconds}`)
    .digest('hex')
    .slice(0, 16);
  return `${videoId}-${hash}.json`;
}

export async function readCachedTranscript(
  cacheDir: string,
  videoId: string,
  model: string,
  maxBlockSeconds: number,
): Promise<Transcript | null> {
  try {
    const raw = await readFile(join(cacheDir, cacheFileName(videoId, model, maxBlockSeconds)), 'utf8');
    const parsed: Transcript = JSON.parse(raw);
    if (parsed.video_id !== videoId || !Array.isArray(parsed.blocks)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function writeCachedTranscript(
  cacheDir: string,
  transcript: Transcript,
  model: string,
  maxBlockSeconds: number,
): Promise<void> {
  await mkdir(cacheDir, { recursive: true });
  const target = join(cacheDir, cacheFileName(transcript.video_id, model, maxBlockSeconds));
  const tmp = `${target}.tmp-${process.pid}`;
  await writeFile(tmp, JSON.stringify(transcript, null, 2) + '\n', 'utf8');
  await rename(tmp, target);
}
