import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ID_FORMATS } from '../ids.js';

// VoiceRequest and VoiceResult, field for field as RFC-004 fixes them.

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((d) => {
    const t = new Date(`${d}T00:00:00Z`).getTime();
    return !Number.isNaN(t) && new Date(t).toISOString().startsWith(d);
  });

export const MAX_SECTIONS = 20;
export const MAX_SECTION_CHARS = 20_000;

const voice = z.object({
  engine: z.literal('edge'),
  name: z.string().regex(/^[A-Za-z]{2,3}-[A-Za-z]{2,4}-[A-Za-z0-9]{1,40}$/),
  rate: z.string().regex(/^[+-]\d{1,3}%$/),
});

const section = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/),
  text: z.string().refine((t) => t.trim() !== '' && [...t].length <= MAX_SECTION_CHARS),
});

const voiceRequest = z.object({
  date: isoDate,
  voice,
  sections: z.array(section).min(1).max(MAX_SECTIONS),
  expect_seconds: z
    .object({ min: z.number().positive(), max: z.number().positive() })
    .refine((e) => e.min <= e.max),
  // Optional explicit tenant id: resolution must match this id and the
  // bearer's caller check on it; absent, the first authorized tenant wins.
  tenant: z.string().regex(ID_FORMATS.tenant).optional(),
});

export type VoiceRequest = z.infer<typeof voiceRequest>;
export type VoiceSettings = VoiceRequest['voice'];
export type VoiceSection = VoiceRequest['sections'][number];

// undefined means the body is not a valid VoiceRequest. Section ids are unique.
export function parseVoiceRequest(body: unknown): VoiceRequest | undefined {
  const parsed = voiceRequest.safeParse(body);
  if (!parsed.success) return undefined;
  const ids = parsed.data.sections.map((s) => s.id);
  if (new Set(ids).size !== ids.length) return undefined;
  return parsed.data;
}

// Hash of the parsed request: key order and unknown extra keys do not change it.
export function requestHash(request: VoiceRequest): string {
  return createHash('sha256').update(JSON.stringify(request)).digest('hex');
}

export const AUDIO_FORMAT = 'audio-24khz-48kbitrate-mono-mp3';

export interface Mark {
  section_id: string;
  index: number;
  start_ms: number;
  end_ms: number;
  text: string;
}

export interface SavedEpisode {
  audio_file_id: string;
  marks_file_id: string;
  names: [string, string];
}

export interface VoiceResult {
  duration_s: number;
  bytes: number;
  sha256: string;
  format: typeof AUDIO_FORMAT;
  marks: Mark[];
  saved?: SavedEpisode;
}
