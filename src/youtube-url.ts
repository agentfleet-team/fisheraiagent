import { TranscriptError } from './errors.js';

const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;

const VIDEO_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'youtube-nocookie.com',
  'www.youtube-nocookie.com',
]);

const ID_PATH_PREFIXES = ['/shorts/', '/embed/', '/live/', '/v/'];

export function parseYouTubeVideoId(input: string): string {
  const raw = input.trim();
  if (VIDEO_ID_PATTERN.test(raw)) return raw;

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new TranscriptError('invalid_url', `not a YouTube URL or video id: ${input}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new TranscriptError('invalid_url', `not a YouTube URL or video id: ${input}`);
  }

  const host = url.hostname.toLowerCase();
  let candidate: string | undefined;

  if (host === 'youtu.be') {
    candidate = url.pathname.split('/').filter(Boolean)[0];
  } else if (VIDEO_HOSTS.has(host)) {
    if (url.pathname === '/watch') {
      candidate = url.searchParams.get('v') ?? undefined;
    } else {
      const prefix = ID_PATH_PREFIXES.find((p) => url.pathname.startsWith(p));
      if (prefix) candidate = url.pathname.slice(prefix.length).split('/')[0];
    }
  }

  if (candidate && VIDEO_ID_PATTERN.test(candidate)) return candidate;
  throw new TranscriptError('invalid_url', `not a YouTube URL or video id: ${input}`);
}

export function canonicalVideoUrl(videoId: string): string {
  return `https://www.youtube.com/watch?v=${videoId}`;
}
