import { TranscriptError } from '../errors.js';
import { canonicalVideoUrl, parseYouTubeVideoId } from '../youtube-url.js';

// Finds the first YouTube URL inside free message text. Only the canonical
// watch URL is handed to the service — never the raw message.
export function findYouTubeUrl(content: string): string | undefined {
  for (const raw of content.split(/\s+/)) {
    if (!raw.toLowerCase().includes('youtu')) continue;
    const token = raw.replace(/^[<(\["']+|[>)\]"'.,;:!?]+$/g, '');
    try {
      return canonicalVideoUrl(parseYouTubeVideoId(token));
    } catch (err) {
      if (err instanceof TranscriptError) continue;
      throw err;
    }
  }
  return undefined;
}
